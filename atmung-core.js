/* Atmung & HRV: Signalkern ohne DOM- oder Bluetooth-Abhängigkeit.
   Tests: tests/atmung-core.test.html */
(function(global){
  "use strict";

  const RR_MIN_MS = 300;
  const RR_MAX_MS = 2000;
  const MEDIAN_HALF_WINDOW = 2;      // zentriert: 2 Schläge davor, Schlag selbst, 2 danach
  const MEDIAN_MAX_DEVIATION = 0.2;
  const PAIR_MIN_DEVIATION = 0.1;    // zu früher Schlag: ein RR 10 % kürzer, der nächste 10 % länger ...
  const PAIR_SUM_TOLERANCE = 0.1;    // ... und zusammen rund zwei normale RR
  const CLOCK_GAP_MS = 2000;         // größere Abweichung zur Ankunftszeit gilt als Signalabriss
  const CLOCK_CORRECTION = 0.05;     // BLE-Latenz nur langsam in die Schlag-Zeitachse einrechnen
  const BACKLOG_MERGE_MS = 1500;     // Nachlieferung schließt die Lücke, wenn weniger als das offen bleibt
  const BACKLOG_AHEAD_MS = 500;      // direkt nach einem möglichen Abriss zählt schon kleiner Vorlauf als Nachlieferung
  const CONTEXT_HISTORY = 30;        // saubere Schläge als langfristige Referenz
  const CONTEXT_MIN_BEATS = 5;
  const CONTEXT_MAX_DEVIATION = 0.4;
  const CONTEXT_MAX_REJECTS = 10;    // danach gilt die Referenz als veraltet, z. B. nach echtem HF-Wechsel
  const RSA_MIN_BEATS = 3;

  /* ---------- BLE-Characteristic 0x2A37 ---------- */
  function parseHeartRateMeasurement(view){
    if(view.byteLength < 2) return null;
    const flags = view.getUint8(0);
    const hr16 = (flags & 0x01) !== 0;
    if(hr16 && view.byteLength < 3) return null;
    const hr = hr16 ? view.getUint16(1, true) : view.getUint8(1);
    let offset = hr16 ? 3 : 2;
    if(flags & 0x08) offset += 2;  // Energy Expended
    const rrMs = [];
    if(flags & 0x10){
      for(; offset + 1 < view.byteLength; offset += 2){
        rrMs.push(view.getUint16(offset, true) * 1000 / 1024);
      }
    }
    return {hr, rrMs, flags};
  }

  function encodeHeartRateMeasurement({hr, rrMs = [], energy = null}){
    const hr16 = hr > 255;
    const size = 1 + (hr16 ? 2 : 1) + (energy !== null ? 2 : 0) + rrMs.length * 2;
    const view = new DataView(new ArrayBuffer(size));
    let flags = hr16 ? 0x01 : 0;
    if(energy !== null) flags |= 0x08;
    if(rrMs.length) flags |= 0x10;
    view.setUint8(0, flags);
    let offset = 1;
    if(hr16){ view.setUint16(offset, hr, true); offset += 2; }
    else { view.setUint8(offset, hr); offset += 1; }
    if(energy !== null){ view.setUint16(offset, energy, true); offset += 2; }
    rrMs.forEach(ms => {
      view.setUint16(offset, Math.min(65535, Math.round(ms * 1024 / 1000)), true);
      offset += 2;
    });
    return view;
  }

  /* ---------- Schlagfolge mit Artefakterkennung ---------- */
  function median(values){
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /* Ein einzelner verschobener Schlag ergibt kurz + lang (oder umgekehrt), zusammen
     rund zwei normale RR. Das stört RMSSD und RSA auch unter der 20-%-Grenze.
     Echte RSA ändert sich dafür von Schlag zu Schlag zu langsam. */
  function isDisplacedPair(a, b, reference){
    const shorter = Math.min(a, b), longer = Math.max(a, b);
    return shorter < reference * (1 - PAIR_MIN_DEVIATION) &&
      longer > reference * (1 + PAIR_MIN_DEVIATION) &&
      Math.abs(a + b - 2 * reference) / (2 * reference) < PAIR_SUM_TOLERANCE;
  }

  /* Beat: {t, rr, status, afterGap}
     t = Ende des RR-Intervalls in der Zeitbasis von arrivalMs.
     status: 'pending' (wartet auf die 2 Folgeschläge), 'ok', 'range', 'median'.
     Der Status eines Beats wird nachträglich im selben Objekt gesetzt: Die
     Live-Kurve kann so sofort zeichnen, Kennwerte zählen nur 'ok'.

     Nach einer Pause können die aufgestauten Pakete praktisch gleichzeitig
     eintreffen. Das erste wirkt wie ein Abriss, die folgenden laufen der Uhr
     davon. Das Segment wird dann so zurückgeschoben, dass sein letzter Schlag
     zur Ankunftszeit passt. Schließt es dabei die Lücke, war es kein Abriss. */
  class SignalPipeline {
    constructor(){
      this.beats = [];
      this.packets = 0;
      this.packetsWithoutRr = 0;
      this.gaps = 0;
      this._cursor = 0;
      this._before = [];
      this._clock = null;
      this._segmentStart = 0;
      this._previousSegmentEnd = null;
      this._recentOk = [];
      this._contextRejects = 0;
    }

    ingest(rrMs, arrivalMs){
      this.packets++;
      if(!rrMs.length){ this.packetsWithoutRr++; return []; }
      const total = rrMs.reduce((sum, rr) => sum + rr, 0);
      let afterGap = false;
      if(this._clock !== null && arrivalMs - (this._clock + total) > CLOCK_GAP_MS){
        this._evaluate(true);
        this._before = [];
        this._previousSegmentEnd = this._clock;
        this._segmentStart = this.beats.length;
        this._clock = null;
        this.gaps++;
        afterGap = true;
      }
      let t = this._clock !== null ? this._clock : arrivalMs - total;
      const added = rrMs.map((rr, i) => {
        t += rr;
        const inRange = rr >= RR_MIN_MS && rr <= RR_MAX_MS;
        return {t, rr, status: inRange ? 'pending' : 'range', afterGap: afterGap && i === 0};
      });
      this.beats.push(...added);
      const aheadLimit = this.beats[this._segmentStart].afterGap ? BACKLOG_AHEAD_MS : CLOCK_GAP_MS;
      if(t - arrivalMs > aheadLimit) t -= this._pullSegmentBack(t - arrivalMs);
      this._clock = t + (arrivalMs - t) * CLOCK_CORRECTION;
      this._evaluate(false);
      return added;
    }

    /* Liefert die tatsächliche Verschiebung; das Segment überlappt nie sein Vorgängersegment. */
    _pullSegmentBack(aheadMs){
      const first = this.beats[this._segmentStart];
      const previousEnd = this._previousSegmentEnd;
      const room = previousEnd === null ? aheadMs : first.t - first.rr - previousEnd;
      const shift = Math.max(0, Math.min(aheadMs, room));
      for(let i = this._segmentStart; i < this.beats.length; i++) this.beats[i].t -= shift;
      if(first.afterGap && room - shift < BACKLOG_MERGE_MS){
        first.afterGap = false;
        this.gaps--;
      }
      return shift;
    }

    /* Bewertet die letzten noch offenen Schläge mit verkürztem Fenster. */
    finish(){ this._evaluate(true); }

    _evaluate(flush){
      const beats = this.beats;
      while(this._cursor < beats.length){
        const head = beats[this._cursor];
        if(head.status === 'range'){ this._cursor++; continue; }
        const after = [];
        for(let i = this._cursor + 1; i < beats.length && after.length < MEDIAN_HALF_WINDOW; i++){
          if(beats[i].status !== 'range') after.push(beats[i].rr);
        }
        if(!flush && after.length < MEDIAN_HALF_WINDOW) break;
        const windowValues = this._before.concat(head.rr, after);
        const reference = median(windowValues);
        const previous = this._before[this._before.length - 1];
        const inPair = windowValues.length >= 3 && (
          (previous !== undefined && isDisplacedPair(previous, head.rr, reference)) ||
          (after.length > 0 && isDisplacedPair(head.rr, after[0], reference)));
        const isArtefact = (windowValues.length >= 3 &&
          Math.abs(head.rr - reference) / reference > MEDIAN_MAX_DEVIATION) || inPair || this._outOfContext(head.rr);
        head.status = isArtefact ? 'median' : 'ok';
        if(!isArtefact){
          this._recentOk.push(head.rr);
          if(this._recentOk.length > CONTEXT_HISTORY) this._recentOk.shift();
        }
        this._before.push(head.rr);
        if(this._before.length > MEDIAN_HALF_WINDOW) this._before.shift();
        this._cursor++;
      }
    }

    /* In einer Störphase ist das ganze 5er-Fenster gestört und der Median taugt
       nicht als Referenz. Grobe Abweichungen vom längerfristigen Niveau fallen
       trotzdem auf. */
    _outOfContext(rr){
      if(this._recentOk.length < CONTEXT_MIN_BEATS) return false;
      const level = median(this._recentOk);
      if(Math.abs(rr - level) / level <= CONTEXT_MAX_DEVIATION){
        this._contextRejects = 0;
        return false;
      }
      this._contextRejects++;
      if(this._contextRejects >= CONTEXT_MAX_REJECTS){
        this._recentOk = [];
        this._contextRejects = 0;
      }
      return true;
    }
  }

  /* ---------- Kennwerte ---------- */
  function beatsBetween(beats, startMs, endMs){
    return beats.filter(b => b.t >= startMs && b.t < endMs);
  }

  /* Nur direkt aufeinanderfolgende saubere Schläge bilden ein Differenzpaar. */
  function rmssd(beats){
    let sum = 0, pairs = 0;
    for(let i = 1; i < beats.length; i++){
      const a = beats[i - 1], b = beats[i];
      if(a.status === 'ok' && b.status === 'ok' && !b.afterGap){
        const diff = b.rr - a.rr;
        sum += diff * diff;
        pairs++;
      }
    }
    return pairs ? Math.sqrt(sum / pairs) : null;
  }

  function lnRmssd(beats){
    const value = rmssd(beats);
    return value ? Math.log(value) : null;
  }

  function artefactStats(beats){
    let total = 0, artefacts = 0;
    beats.forEach(b => {
      if(b.status === 'pending') return;
      total++;
      if(b.status !== 'ok') artefacts++;
    });
    const rate = total ? artefacts / total : null;
    return {total, artefacts, rate, quality: signalQuality(rate)};
  }

  function signalQuality(rate){
    if(rate === null) return null;
    if(rate < 0.02) return 'gut';
    return rate <= 0.05 ? 'mäßig' : 'schlecht';
  }

  /* HFmax − HFmin eines Zyklus aus der momentanen HF sauberer Schläge.
     Max − Min hängt an einem einzigen Wert: Zyklen mit Artefakt zählen nicht,
     weil auch ihre "sauberen" Schläge oft noch gestört sind. */
  function rsaAmplitude(beats, startMs, endMs){
    const segment = beatsBetween(beats, startMs, endMs);
    if(segment.some(b => b.status === 'range' || b.status === 'median')) return null;
    const hrs = segment
      .filter(b => b.status === 'ok')
      .map(b => 60000 / b.rr);
    if(hrs.length < RSA_MIN_BEATS) return null;
    return Math.max(...hrs) - Math.min(...hrs);
  }

  /* cycles: [{start, end}]. Zyklen mit zu wenigen Schlägen zählen nicht in den Mittelwert. */
  function rsaSummary(beats, cycles){
    const perCycle = cycles.map(c => rsaAmplitude(beats, c.start, c.end));
    const valid = perCycle.filter(v => v !== null);
    const mean = valid.length ? valid.reduce((sum, v) => sum + v, 0) / valid.length : null;
    return {perCycle, mean, last: valid.length ? valid[valid.length - 1] : null};
  }

  /* ---------- Atemmuster ---------- */
  const BPM_OPTIONS = [4.5, 5, 5.5, 6, 6.5, 7];
  const IE_OPTIONS = {'1:1': 0.5, '4:6': 0.4};

  /* Phasen sind eine frei definierbare Liste, damit auch mehrteilige Muster passen.
     from/to: Füllstand des Pacers von 0 (leer) bis 1 (voll). */
  function buildBreathPattern(bpm, ie){
    const cycleMs = 60000 / bpm;
    const inhaleShare = IE_OPTIONS[ie] || IE_OPTIONS['1:1'];
    return {
      bpm, ie, cycleMs,
      phases: [
        {kind:'in', label:'Einatmen', ms:cycleMs * inhaleShare, from:0, to:1},
        {kind:'out', label:'Ausatmen', ms:cycleMs * (1 - inhaleShare), from:1, to:0}
      ]
    };
  }

  function pacerState(pattern, elapsedMs){
    const elapsed = Math.max(0, elapsedMs);
    const cycleIndex = Math.floor(elapsed / pattern.cycleMs);
    let position = elapsed - cycleIndex * pattern.cycleMs;
    let phaseIndex = 0;
    while(phaseIndex < pattern.phases.length - 1 && position >= pattern.phases[phaseIndex].ms){
      position -= pattern.phases[phaseIndex].ms;
      phaseIndex++;
    }
    const phase = pattern.phases[phaseIndex];
    const progress = Math.min(1, position / phase.ms);
    const eased = (1 - Math.cos(Math.PI * progress)) / 2;
    return {
      cycleIndex, phaseIndex, progress,
      kind: phase.kind,
      label: phase.label,
      level: phase.from + (phase.to - phase.from) * eased
    };
  }

  /* Abgeschlossene Zyklen im Bereich, für die RSA-Zuordnung. */
  function pacerCycles(pattern, startMs, endMs){
    const cycles = [];
    for(let start = startMs; start + pattern.cycleMs <= endMs; start += pattern.cycleMs){
      cycles.push({start, end: start + pattern.cycleMs});
    }
    return cycles;
  }

  /* Phasenbänder ab Pacer-Start, überlappend mit [fromMs, toMs). */
  function pacerBands(pattern, startMs, fromMs, toMs){
    const bands = [];
    const firstCycle = Math.max(0, Math.floor((fromMs - startMs) / pattern.cycleMs));
    let t = startMs + firstCycle * pattern.cycleMs;
    while(t < toMs){
      for(const phase of pattern.phases){
        const end = t + phase.ms;
        if(end > fromMs && t < toMs) bands.push({start:Math.max(t, fromMs), end:Math.min(end, toMs), kind:phase.kind});
        t = end;
      }
    }
    return bands;
  }

  /* ---------- Session-Auswertung ---------- */
  function segmentStats(beats, range){
    if(!range) return null;
    const segment = beatsBetween(beats, range.start, range.end);
    const clean = segment.filter(b => b.status === 'ok');
    if(!clean.length) return null;
    const meanRr = clean.reduce((sum, b) => sum + b.rr, 0) / clean.length;
    return {rmssd: rmssd(segment), lnRmssd: lnRmssd(segment), hr: 60000 / meanRr, beats: clean.length};
  }

  function summarizeSession({beats, pattern, baseline, pacer, post}){
    const cycles = pacer ? pacerCycles(pattern, pacer.start, pacer.end) : [];
    const rsa = rsaSummary(beats, cycles);
    const stats = artefactStats(beats);
    return {
      baseline: segmentStats(beats, baseline),
      post: segmentStats(beats, post),
      pacerRmssd: pacer ? rmssd(beatsBetween(beats, pacer.start, pacer.end)) : null,
      rsaMean: rsa.mean,
      cycleCount: rsa.perCycle.filter(v => v !== null).length,
      artefactRate: stats.rate,
      artefactCount: stats.artefacts,
      beatCount: stats.total,
      quality: stats.quality
    };
  }

  /* ---------- Simulator ---------- */
  function createRrSimulator(options = {}){
    const {meanRr = 900, amplitude = 60, breathHz = 0.1, noiseSd = 8, artefactProb = 0.01, rng = Math.random} = options;
    let breathPhase = 0;
    let currentHz = breathHz;
    const queued = [];
    function gaussian(){
      return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    }
    return {
      setBreathHz(hz){ currentHz = hz; },
      /* injected = absichtlich erzeugtes Artefakt, zur Prüfung des Filters */
      next(){
        let beat = queued.shift();
        if(!beat){
          const clean = meanRr + amplitude * Math.sin(breathPhase) + noiseSd * gaussian();
          if(rng() < artefactProb){
            const kind = rng();
            if(kind < 0.5){            // Extraschlag: kurz, danach kompensatorisch lang
              beat = {rr: clean * 0.6, injected: true};
              queued.push({rr: clean * 1.4, injected: true});
            } else if(kind < 0.8){     // verpasster Schlag
              beat = {rr: clean * 2, injected: true};
            } else {                   // Störimpuls
              beat = {rr: 250, injected: true};
            }
          } else {
            beat = {rr: clean, injected: false};
          }
        }
        breathPhase += 2 * Math.PI * currentHz * beat.rr / 1000;
        return beat;
      }
    };
  }

  global.AtemCore = {
    RR_MIN_MS, RR_MAX_MS,
    parseHeartRateMeasurement, encodeHeartRateMeasurement,
    SignalPipeline, median,
    beatsBetween, rmssd, lnRmssd, artefactStats, signalQuality, rsaAmplitude, rsaSummary,
    BPM_OPTIONS, IE_OPTIONS, buildBreathPattern, pacerState, pacerCycles, pacerBands, summarizeSession,
    createRrSimulator
  };
})(window);
