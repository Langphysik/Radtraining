/* Atmung & HRV: Signalkern ohne DOM- oder Bluetooth-Abhängigkeit.
   Tests: tests/atmung-core.test.html */
(function(global){
  "use strict";

  const RR_MIN_MS = 300;
  const RR_MAX_MS = 2000;
  const MEDIAN_HALF_WINDOW = 2;      // zentriert: 2 Schläge davor, Schlag selbst, 2 danach
  const MEDIAN_MAX_DEVIATION = 0.2;
  const CLOCK_GAP_MS = 2000;         // größere Abweichung zur Ankunftszeit gilt als Signalabriss
  const CLOCK_CORRECTION = 0.05;     // BLE-Latenz nur langsam in die Schlag-Zeitachse einrechnen
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

  /* Beat: {t, rr, status, afterGap}
     t = Ende des RR-Intervalls in der Zeitbasis von arrivalMs.
     status: 'pending' (wartet auf die 2 Folgeschläge), 'ok', 'range', 'median'.
     Der Status eines Beats wird nachträglich im selben Objekt gesetzt: Die
     Live-Kurve kann so sofort zeichnen, Kennwerte zählen nur 'ok'. */
  class SignalPipeline {
    constructor(){
      this.beats = [];
      this.packets = 0;
      this.packetsWithoutRr = 0;
      this.gaps = 0;
      this._cursor = 0;
      this._before = [];
      this._clock = null;
    }

    ingest(rrMs, arrivalMs){
      this.packets++;
      if(!rrMs.length){ this.packetsWithoutRr++; return []; }
      const total = rrMs.reduce((sum, rr) => sum + rr, 0);
      let afterGap = false;
      if(this._clock !== null && Math.abs(arrivalMs - (this._clock + total)) > CLOCK_GAP_MS){
        this._evaluate(true);
        this._before = [];
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
      this._clock = t + (arrivalMs - t) * CLOCK_CORRECTION;
      this._evaluate(false);
      return added;
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
        const isArtefact = windowValues.length >= 3 &&
          Math.abs(head.rr - reference) / reference > MEDIAN_MAX_DEVIATION;
        head.status = isArtefact ? 'median' : 'ok';
        this._before.push(head.rr);
        if(this._before.length > MEDIAN_HALF_WINDOW) this._before.shift();
        this._cursor++;
      }
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

  /* HFmax − HFmin eines Zyklus aus der momentanen HF sauberer Schläge. */
  function rsaAmplitude(beats, startMs, endMs){
    const hrs = beatsBetween(beats, startMs, endMs)
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

  /* ---------- Simulator ---------- */
  function createRrSimulator(options = {}){
    const {meanRr = 900, amplitude = 60, breathHz = 0.1, noiseSd = 8, artefactProb = 0.01, rng = Math.random} = options;
    let elapsedS = 0;
    const queued = [];
    function gaussian(){
      return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    }
    return {
      /* injected = absichtlich erzeugtes Artefakt, zur Prüfung des Filters */
      next(){
        let beat = queued.shift();
        if(!beat){
          const clean = meanRr + amplitude * Math.sin(2 * Math.PI * breathHz * elapsedS) + noiseSd * gaussian();
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
        elapsedS += beat.rr / 1000;
        return beat;
      }
    };
  }

  global.AtemCore = {
    RR_MIN_MS, RR_MAX_MS,
    parseHeartRateMeasurement, encodeHeartRateMeasurement,
    SignalPipeline, median,
    beatsBetween, rmssd, lnRmssd, artefactStats, signalQuality, rsaAmplitude, rsaSummary,
    createRrSimulator
  };
})(window);
