/* Atmung & HRV: Menü, Unterseiten, Gurtverbindung und Signal-Ansicht.
   Signalverarbeitung: atmung-core.js. App-Helfer kommen über window.RT aus index.html. */
(function(){
  "use strict";

  const RT = window.RT, Core = window.AtemCore;
  const navEl = document.getElementById('atemNav');
  if(!RT || !Core || !navEl) return;

  const SETTINGS_KEY = 'atem:settings';
  const SESSIONS_KEY = 'atem:sessions';
  const RR_KEY_PREFIX = 'atem:rr:';
  const RF_RESULTS_KEY = 'atem:rf-results';
  const PLANS_KEY = 'atem:plans';
  const ACTIVE_PLAN_KEY = 'atem:active-plan';
  const MORNING_KEY = 'atem:morning';
  const HARD_TRAINING_TAGS = ['threshold', 'vo2max'];
  const SIM_PROFILES = {
    normal: {label:'Normal (900 ± 60 ms)', meanRr:900, amplitude:60},
    stark: {label:'Starke RSA (1030 ± 170 ms)', meanRr:1030, amplitude:170}
  };
  const QUALITY_COLORS = {gut:'var(--good)', 'mäßig':'var(--gold)', schlecht:'var(--crimson)'};
  const DEBUG_RSA_WINDOW_MS = 10000;
  const CURVE_SPAN_MS = 60000;
  const NO_RR_WARNING_PACKETS = 10;
  const REST_MEASUREMENT_MS = 60000;
  const SESSION_MINUTES = [5, 10, 15, 20];
  const EVENING_FROM_HOUR = 19;
  const EVENING_UNTIL_HOUR = 5;
  const RSA_TREND_CYCLES = 12;
  const RSA_EVALUATION_DELAY_MS = 2500;  // der Artefaktfilter bewertet Schläge erst nach 2 Folgeschlägen
  const BAND_COLORS = {in:'rgba(111,180,219,.14)', out:'rgba(231,178,79,.09)'};
  const STEP_LABELS = {baseline:'Ruhemessung vorher', pacer:'Atem-Session', post:'Ruhemessung nachher'};

  function fmt(value, digits){
    return value === null || value === undefined ? '–' : value.toFixed(digits).replace('.', ',');
  }
  function fmtBpm(bpm){ return fmt(bpm, Number.isInteger(bpm) ? 0 : 1); }
  function fmtCountdown(ms){
    const total = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function round2(value){ return value === null || value === undefined ? null : Math.round(value * 100) / 100; }

  /* ---------- Einstellungen ---------- */
  let settings = {
    navOpen: false,
    bpm: 6,
    ie: '1:1',
    durationMin: 10,
    tone: false,
    vibrate: false,
    showFeedback: true,
    eveningMode: 'auto',  // auto | an | aus
    keepRr: false,
    weeklyGoal: 5
  };
  async function loadSettings(){
    try{
      const stored = await RT.store.get(SETTINGS_KEY);
      if(stored) settings = Object.assign(settings, JSON.parse(stored.value));
    }catch(e){ console.error('Atmung: Einstellungen nicht lesbar', e); }
  }
  async function saveSettings(){
    try{ await RT.store.set(SETTINGS_KEY, JSON.stringify(settings)); }
    catch(e){ console.error('Atmung: Einstellungen nicht gespeichert', e); }
  }

  /* ---------- Signalquelle: Gurt oder Simulator ---------- */
  const signal = {
    source: null,        // 'ble' | 'sim'
    status: 'getrennt',  // getrennt | verbinde | verbunden | unterbrochen | simulator
    deviceName: null,
    battery: null,
    error: null,
    hr: null,
    lastPacketHex: null,
    visibilityLog: [],
    pipeline: new Core.SignalPipeline(),
    listeners: new Set(),
    notify(){ this.listeners.forEach(fn => fn()); },
    setStatus(status){ this.status = status; this.notify(); },
    resetRecording(){
      this.pipeline = new Core.SignalPipeline();
      this.hr = null;
      this.lastPacketHex = null;
      this.visibilityLog = [];
      this.notify();
    },
    handlePacket(view){
      const parsed = Core.parseHeartRateMeasurement(view);
      if(!parsed) return;
      this.hr = parsed.hr;
      this.lastPacketHex = Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
        .map(byte => byte.toString(16).padStart(2, '0')).join(' ');
      this.pipeline.ingest(parsed.rrMs, performance.now());
      this.notify();
    }
  };

  document.addEventListener('visibilitychange', () => {
    signal.visibilityLog.push({t:Math.round(performance.now()), state:document.visibilityState});
  });

  const ble = {
    device: null,
    characteristic: null,
    intentionalDisconnect: false,
    get supported(){ return !!navigator.bluetooth; },
    onValue(event){ signal.handlePacket(event.target.value); },

    async connect(){
      signal.error = null;
      sim.stop();
      let device;
      try{
        device = await navigator.bluetooth.requestDevice({
          filters: [{services:['heart_rate']}],
          optionalServices: ['battery_service']
        });
      }catch(e){
        // NotFoundError = Auswahldialog ohne Gerätewahl geschlossen: kein Fehlerfall
        if(e.name !== 'NotFoundError') signal.error = 'Gerätesuche fehlgeschlagen: ' + e.message;
        signal.notify();
        return;
      }
      if(this.device) this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
      this.device = device;
      device.addEventListener('gattserverdisconnected', this.onDisconnected);
      signal.deviceName = device.name || 'Unbenannter Gurt';
      if(signal.source !== 'ble') signal.resetRecording();
      await this.open();
    },

    async open(){
      signal.error = null;
      signal.source = 'ble';
      signal.setStatus('verbinde');
      try{
        const server = await this.device.gatt.connect();
        const service = await server.getPrimaryService('heart_rate');
        const characteristic = await service.getCharacteristic('heart_rate_measurement');
        if(this.characteristic) this.characteristic.removeEventListener('characteristicvaluechanged', this.onValue);
        this.characteristic = characteristic;
        characteristic.addEventListener('characteristicvaluechanged', this.onValue);
        await characteristic.startNotifications();
        this.intentionalDisconnect = false;
        signal.setStatus('verbunden');
        this.readBattery(server);
      }catch(e){
        signal.error = 'Verbindung fehlgeschlagen: ' + e.message +
          '. Ist der Gurt noch mit der Sigma-App oder dem Radcomputer verbunden?';
        signal.setStatus('unterbrochen');
      }
    },

    async readBattery(server){
      try{
        const service = await server.getPrimaryService('battery_service');
        const characteristic = await service.getCharacteristic('battery_level');
        const value = await characteristic.readValue();
        signal.battery = value.getUint8(0);
      }catch(e){
        signal.battery = null;  // Akkustand ist optional, nicht jeder Gurt liefert ihn
      }
      signal.notify();
    },

    onDisconnected(){
      signal.setStatus(ble.intentionalDisconnect ? 'getrennt' : 'unterbrochen');
    },

    disconnect(){
      if(!this.device) return;
      this.intentionalDisconnect = true;
      if(this.device.gatt.connected) this.device.gatt.disconnect();
      else signal.setStatus('getrennt');
    }
  };
  ble.onValue = ble.onValue.bind(ble);

  const sim = {
    timer: null,
    generator: null,
    get running(){ return this.timer !== null; },

    start(profileKey){
      this.stop();
      if(ble.device && ble.device.gatt.connected) ble.disconnect();
      const profile = SIM_PROFILES[profileKey] || SIM_PROFILES.normal;
      this.generator = Core.createRrSimulator({meanRr:profile.meanRr, amplitude:profile.amplitude});
      signal.resetRecording();
      signal.source = 'sim';
      signal.error = null;
      signal.deviceName = 'Simulator';
      signal.battery = null;
      signal.setStatus('simulator');
      this.schedule();
    },

    setBreathHz(hz, scale){ if(this.generator) this.generator.setBreathHz(hz, scale); },

    schedule(){
      const {rr} = this.generator.next();
      this.timer = setTimeout(() => {
        const hr = Math.min(255, Math.round(60000 / rr));
        signal.handlePacket(Core.encodeHeartRateMeasurement({hr, rrMs:[rr]}));
        this.schedule();
      }, rr);
    },

    stop(){
      if(this.timer === null) return;
      clearTimeout(this.timer);
      this.timer = null;
      signal.setStatus('getrennt');
    }
  };

  /* ---------- Menü-Status ---------- */
  const STATUS_LABELS = {
    getrennt: 'Kein Gurt verbunden',
    verbinde: 'Verbinde…',
    verbunden: 'Gurt verbunden',
    unterbrochen: 'Verbindung unterbrochen',
    simulator: 'Simulator läuft'
  };
  const STATUS_COLORS = {
    getrennt: 'var(--ink-dim)',
    verbinde: 'var(--gold)',
    verbunden: 'var(--good)',
    unterbrochen: 'var(--crimson)',
    simulator: 'var(--glacier)'
  };
  function renderMenuStatus(){
    const el = document.getElementById('atemNavStatus');
    el.textContent = STATUS_LABELS[signal.status];
    el.style.setProperty('--atem-status', STATUS_COLORS[signal.status]);
  }
  signal.listeners.add(renderMenuStatus);

  /* ---------- Signal-Ansicht ---------- */
  function renderSignalView(root){
    root.innerHTML =
      connectionCardsHtml() +
      '<div class="atem-card">' +
        '<div class="atem-stats">' +
          stat('atemHr', 'HF (bpm)') + stat('atemRr', 'Letzter RR (ms)') + stat('atemBeatCount', 'Schläge') +
          stat('atemQuality', 'Artefakte') + stat('atemRmssd', 'RMSSD (ms)') + stat('atemLnRmssd', 'lnRMSSD') +
          stat('atemRsaLast', 'RSA letztes Fenster') + stat('atemRsaMean', 'RSA Mittel') + stat('atemGaps', 'Signalabrisse') +
        '</div>' +
        '<p class="atem-hint">RSA hier in festen 10-s-Fenstern als Rohwert. Die Zuordnung zu den Atemzyklen kommt mit dem Pacer.</p>' +
        '<p class="atem-error" id="atemNoRr" role="alert"></p>' +
      '</div>' +
      '<div class="atem-card">' +
        '<h3 class="atem-card-title">HF, letzte 60 s</h3>' +
        '<canvas class="atem-curve" id="atemCurve"></canvas>' +
      '</div>' +
      '<div class="atem-card">' +
        '<h3 class="atem-card-title">Rohdaten</h3>' +
        '<p class="atem-hint">Letztes Paket: <span class="mono" id="atemHex">–</span></p>' +
        '<div class="atem-actions">' +
          '<button class="atem-btn" id="atemReset">Aufzeichnung leeren</button>' +
          '<button class="atem-btn" id="atemExport">Als JSON sichern</button>' +
        '</div>' +
        '<div class="table-scroll atem-beats"><table class="history-table"><thead><tr><th>Zeit (s)</th><th>RR (ms)</th><th>HF</th><th>Status</th></tr></thead><tbody id="atemBeatRows"></tbody></table></div>' +
      '</div>';

    const byId = id => document.getElementById(id);
    const setText = (id, text) => { byId(id).textContent = text; };

    const updateConnection = bindConnectionCards();
    byId('atemReset').addEventListener('click', () => signal.resetRecording());
    byId('atemExport').addEventListener('click', () => {
      const {pipeline} = signal;
      RT.downloadJSON({
        exportedAt: new Date().toISOString(),
        source: signal.source,
        device: signal.deviceName,
        packets: pipeline.packets,
        packetsWithoutRr: pipeline.packetsWithoutRr,
        visibility: signal.visibilityLog,
        beats: pipeline.beats.map(b => ({t:Math.round(b.t), rr:Math.round(b.rr * 100) / 100, status:b.status, afterGap:b.afterGap}))
      }, 'atmung-signal-' + RT.toISODate(new Date()) + '.json');
    });

    function update(){
      const {pipeline} = signal;
      const stats = Core.artefactStats(pipeline.beats);
      const latest = pipeline.beats[pipeline.beats.length - 1];

      updateConnection();
      setText('atemNoRr', pipeline.packetsWithoutRr >= NO_RR_WARNING_PACKETS && !pipeline.beats.length
        ? 'Der Gurt sendet HF, aber keine RR-Intervalle.' : '');

      setText('atemHr', signal.hr === null ? '–' : String(signal.hr));
      setText('atemRr', latest ? fmt(latest.rr, 0) : '–');
      setText('atemBeatCount', String(pipeline.beats.length));
      const qualityEl = byId('atemQuality');
      qualityEl.textContent = stats.quality
        ? fmt(stats.rate * 100, 1) + ' % · ' + stats.quality : '–';
      qualityEl.style.color = stats.quality ? QUALITY_COLORS[stats.quality] : '';
      setText('atemRmssd', fmt(Core.rmssd(pipeline.beats), 1));
      setText('atemLnRmssd', fmt(Core.lnRmssd(pipeline.beats), 2));
      const rsa = Core.rsaSummary(pipeline.beats, completedWindows(pipeline.beats));
      setText('atemRsaLast', rsa.last === null ? '–' : fmt(rsa.last, 1) + ' bpm');
      setText('atemRsaMean', rsa.mean === null ? '–' : fmt(rsa.mean, 1) + ' bpm');
      setText('atemGaps', String(pipeline.gaps));
      setText('atemHex', signal.lastPacketHex || '–');

      byId('atemBeatRows').innerHTML = pipeline.beats.slice(-30).reverse().map(beat => {
        const start = pipeline.beats[0].t;
        return '<tr class="' + (beat.status === 'range' || beat.status === 'median' ? 'atem-artefact' : '') + '">' +
          '<td class="mono">' + fmt((beat.t - start) / 1000, 1) + '</td>' +
          '<td class="mono">' + fmt(beat.rr, 1) + '</td>' +
          '<td class="mono">' + fmt(60000 / beat.rr, 0) + '</td>' +
          '<td>' + BEAT_STATUS_LABELS[beat.status] + '</td></tr>';
      }).join('');
    }

    const canvas = byId('atemCurve');
    const redraw = () => drawHeartRateCurve(canvas, signal.pipeline.beats, performance.now());
    signal.listeners.add(update);
    const curveTimer = setInterval(redraw, 250);
    update();
    redraw();
    return () => {
      signal.listeners.delete(update);
      clearInterval(curveTimer);
    };
  }

  /* ---------- Verbindungskarte (Signal-Ansicht und Session-Vorbereitung) ---------- */
  function connectionCardsHtml(simulatorCollapsed){
    const profileOptions = Object.keys(SIM_PROFILES)
      .map(key => '<option value="' + key + '">' + RT.escapeHtml(SIM_PROFILES[key].label) + '</option>').join('');
    return '<div class="atem-card">' +
        '<div class="atem-status-line"><span class="atem-dot" id="atemConnDot"></span><strong id="atemConnState"></strong><span class="atem-muted" id="atemConnDetail"></span></div>' +
        '<p class="atem-hint">Der Sigma-Gurt erlaubt nur eine BLE-Verbindung. Trenne vorher die Sigma-App und den Radcomputer. Befeuchte die Elektroden und leg den Gurt straff an: Das macht für saubere Werte den größten Unterschied.</p>' +
        '<div class="atem-actions">' +
          '<button class="atem-btn primary" id="atemConnect">Gurt verbinden</button>' +
          '<button class="atem-btn" id="atemReconnect">Neu verbinden</button>' +
          '<button class="atem-btn" id="atemDisconnect">Trennen</button>' +
        '</div>' +
        '<p class="atem-error" id="atemError" role="alert"></p>' +
      '</div>' +
      foldableCard('Simulator', simulatorCollapsed,
        '<div class="atem-actions">' +
          '<select class="atem-select" id="atemSimProfile" aria-label="Simulator-Profil">' + profileOptions + '</select>' +
          '<button class="atem-btn" id="atemSimToggle"></button>' +
        '</div>');
  }

  function foldableCard(title, collapsed, content){
    if(!collapsed) return '<div class="atem-card"><h3 class="atem-card-title">' + title + '</h3>' + content + '</div>';
    return '<details class="atem-card atem-fold"><summary class="atem-card-title"><span class="atem-fold-caret">▸</span>' + title + '</summary>' + content + '</details>';
  }

  /* Liefert die Aktualisierungsfunktion; aufrufen, sobald sich das Signal ändert. */
  function bindConnectionCards(){
    const byId = id => document.getElementById(id);
    byId('atemConnect').addEventListener('click', () => ble.connect());
    byId('atemReconnect').addEventListener('click', () => ble.open());
    byId('atemDisconnect').addEventListener('click', () => {
      if(sim.running) sim.stop(); else ble.disconnect();
    });
    byId('atemSimToggle').addEventListener('click', () => {
      if(sim.running) sim.stop(); else sim.start(byId('atemSimProfile').value);
    });
    return function updateConnection(){
      byId('atemConnState').textContent = STATUS_LABELS[signal.status];
      byId('atemConnDot').style.background = STATUS_COLORS[signal.status];
      byId('atemConnDetail').textContent = [
        signal.deviceName,
        signal.battery !== null ? 'Akku ' + signal.battery + ' %' : null
      ].filter(Boolean).join(' · ');

      const busy = signal.status === 'verbinde';
      byId('atemConnect').disabled = !ble.supported || busy;
      byId('atemConnect').hidden = signalActive();
      byId('atemReconnect').hidden = !(ble.device && signal.status === 'unterbrochen');
      byId('atemDisconnect').hidden = !signalActive();
      byId('atemSimToggle').textContent = sim.running ? 'Simulator stoppen' : 'Simulator starten';
      byId('atemSimProfile').disabled = sim.running;

      let errorText = signal.error || '';
      if(!errorText && !ble.supported){
        errorText = 'Web Bluetooth ist hier nicht verfügbar. Nutze Chrome auf Android über https oder den Simulator.';
      }
      byId('atemError').textContent = errorText;
    };
  }

  function signalActive(){ return signal.status === 'verbunden' || signal.status === 'simulator'; }

  const BEAT_STATUS_LABELS = {
    pending: 'wird geprüft',
    ok: 'ok',
    range: 'Artefakt: Bereich',
    median: 'Artefakt: Median'
  };

  function stat(id, label){
    return '<div class="field"><div class="v atem-stat-value" id="' + id + '">–</div><div class="l">' + label + '</div></div>';
  }

  /* Nur abgeschlossene Fenster: Am aktuellen Ende fehlen noch bewertete Schläge. */
  function completedWindows(beats){
    if(!beats.length) return [];
    const windows = [];
    const first = beats[0].t;
    const last = beats[beats.length - 1].t;
    for(let start = first; start + DEBUG_RSA_WINDOW_MS + 3000 <= last; start += DEBUG_RSA_WINDOW_MS){
      windows.push({start, end:start + DEBUG_RSA_WINDOW_MS});
    }
    return windows;
  }

  function drawHeartRateCurve(canvas, beats, now, bands){
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if(!width || !height) return;
    if(canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)){
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const css = getComputedStyle(canvas);
    const from = now - CURVE_SPAN_MS;
    const visible = beats.filter(b => b.t >= from && (b.status === 'ok' || b.status === 'pending'));
    if(visible.length < 2){
      ctx.fillStyle = css.getPropertyValue('--ink-dim').trim();
      ctx.font = "12px 'IBM Plex Mono', monospace";
      ctx.fillText('Noch keine Daten', 10, height / 2);
      return;
    }

    const rates = visible.map(b => 60000 / b.rr);
    // Ungeprüfte Schläge können Artefakte sein: Sie bestimmen die Skala nur, solange sonst nichts da ist.
    const checkedRates = rates.filter((_, i) => visible[i].status === 'ok');
    const scaleRates = checkedRates.length >= 2 ? checkedRates : rates;
    const minRate = Math.floor(Math.min(...scaleRates) / 5) * 5;
    const maxRate = Math.max(minRate + 10, Math.ceil(Math.max(...scaleRates) / 5) * 5);
    const labelWidth = 28;
    const x = t => labelWidth + (t - from) / CURVE_SPAN_MS * (width - labelWidth);
    const y = rate => {
      const clamped = Math.min(maxRate, Math.max(minRate, rate));
      return 8 + (maxRate - clamped) / (maxRate - minRate) * (height - 16);
    };

    (bands || []).forEach(band => {
      ctx.fillStyle = BAND_COLORS[band.kind];
      ctx.fillRect(x(band.start), 0, x(band.end) - x(band.start), height);
    });

    ctx.strokeStyle = css.getPropertyValue('--line-soft').trim();
    ctx.fillStyle = css.getPropertyValue('--ink-dim').trim();
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.lineWidth = 1;
    [minRate, (minRate + maxRate) / 2, maxRate].forEach(rate => {
      ctx.beginPath();
      ctx.moveTo(labelWidth, y(rate));
      ctx.lineTo(width, y(rate));
      ctx.stroke();
      ctx.fillText(String(Math.round(rate)), 0, y(rate) + 3);
    });

    ctx.strokeStyle = css.getPropertyValue('--glacier').trim();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    visible.forEach((beat, i) => {
      const px = x(beat.t), py = y(rates[i]);
      if(i === 0 || beat.afterGap) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  function drawSparkline(canvas, values){
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if(!width || !height) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if(values.length < 2) return;
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue('--glacier').trim();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    values.forEach((value, i) => {
      const px = i / (values.length - 1) * (width - 4) + 2;
      const py = height - 3 - (value - min) / span * (height - 6);
      if(i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  /* ---------- Hinweise am Phasenwechsel ---------- */
  const cues = {
    audio: null,
    /* Browser erlauben Ton nur nach einer Nutzeraktion: beim Start-Tipp aufrufen. */
    prepare(){
      if(!settings.tone) return;
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if(!AudioCtor) return;
      if(!this.audio) this.audio = new AudioCtor();
      if(this.audio.state === 'suspended') this.audio.resume();
    },
    tone(frequency, seconds, peak){
      if(!settings.tone) return;
      this.prepare();
      if(!this.audio) return;
      const start = this.audio.currentTime;
      const oscillator = this.audio.createOscillator();
      const gain = this.audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
      oscillator.connect(gain).connect(this.audio.destination);
      oscillator.start(start);
      oscillator.stop(start + seconds);
    },
    vibrate(pattern){
      if(settings.vibrate && navigator.vibrate) navigator.vibrate(pattern);
    },
    phase(kind){
      // Handylautsprecher geben tiefe Töne schlecht wieder; kurze Vibration ist kaum spürbar.
      if(kind === 'in'){ this.tone(660, 0.4, 0.18); this.vibrate(150); }
      else { this.tone(495, 0.4, 0.18); this.vibrate([100, 100, 100]); }
    },
    step(){
      this.tone(784, 0.7, 0.2);
      this.vibrate(400);
    }
  };

  /* ---------- Bildschirm anhalten ---------- */
  const wakeLock = {
    sentinel: null,
    wanted: false,
    failed: false,
    onChange: null,
    async acquire(){
      this.wanted = true;
      if(!navigator.wakeLock){ this.setFailed(true); return; }
      try{
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => { this.sentinel = null; });
        this.setFailed(false);
      }catch(e){
        this.setFailed(true);
      }
    },
    setFailed(failed){
      this.failed = failed;
      if(this.onChange) this.onChange();
    },
    release(){
      this.wanted = false;
      this.failed = false;
      if(this.sentinel) this.sentinel.release();
      this.sentinel = null;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && wakeLock.wanted && !wakeLock.sentinel) wakeLock.acquire();
  });

  /* ---------- Sessions speichern ---------- */
  async function loadSessions(){
    const stored = await RT.store.get(SESSIONS_KEY);
    return stored ? JSON.parse(stored.value) : [];
  }
  /* Fehler laufen bewusst zum Aufrufer: Eine Session darf nicht unbemerkt verloren gehen. */
  async function saveSession(record, rrData){
    const sessions = await loadSessions();
    if(rrData) await RT.store.set(RR_KEY_PREFIX + record.id, JSON.stringify(rrData));
    sessions.push(record);
    try{
      await RT.store.set(SESSIONS_KEY, JSON.stringify(sessions));
    }catch(e){
      if(rrData) await RT.store.delete(RR_KEY_PREFIX + record.id);
      throw e;
    }
  }

  function eveningActive(){
    if(settings.eveningMode === 'an') return true;
    if(settings.eveningMode === 'aus') return false;
    const hour = new Date().getHours();
    return hour >= EVENING_FROM_HOUR || hour < EVENING_UNTIL_HOUR;
  }

  /* ---------- Formularbausteine ---------- */
  function scaleHtml(id, label){
    let chips = '';
    for(let value = 0; value <= 10; value++){
      chips += '<button type="button" class="atem-chip" data-value="' + value + '" aria-pressed="false">' + value + '</button>';
    }
    return '<div class="atem-scale" id="' + id + '" role="group" aria-label="' + label + '">' + chips + '</div>';
  }
  function bindScale(id, onChange){
    const group = document.getElementById(id);
    group.addEventListener('click', event => {
      const chip = event.target.closest('.atem-chip');
      if(!chip) return;
      const wasActive = chip.getAttribute('aria-pressed') === 'true';
      group.querySelectorAll('.atem-chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
      if(!wasActive) chip.setAttribute('aria-pressed', 'true');
      onChange(wasActive ? null : Number(chip.dataset.value));
    });
  }
  function optionsHtml(items, selected){
    return items.map(item => '<option value="' + item.value + '"' + (String(item.value) === String(selected) ? ' selected' : '') + '>' + item.label + '</option>').join('');
  }
  function checkHtml(id, label, checked){
    return '<label class="atem-check"><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '><span>' + label + '</span></label>';
  }
  function fmtIsoDate(iso){
    const [year, month, day] = iso.split('-');
    return day + '.' + month + '.' + year;
  }
  function todayIso(){ return RT.toISODate(new Date()); }
  function saveSetting(key, value){ settings[key] = value; saveSettings(); }

  /* Karte mit Ton, Vibration, Feedback und Abendmodus; onEvening reagiert auf den Moduswechsel. */
  function cueOptionsHtml(withRr){
    return foldableCard('Anzeige und Hinweise <span class="atem-fold-note" id="atemCueNote"></span>', true,
      '<div class="atem-checks">' +
        checkHtml('atemTone', 'Leiser Ton am Phasenwechsel', settings.tone) +
        checkHtml('atemVibrate', navigator.vibrate ? 'Vibration am Phasenwechsel' : 'Vibration (auf diesem Gerät nicht verfügbar)', settings.vibrate && !!navigator.vibrate) +
        checkHtml('atemFeedback', 'Live-Feedback anzeigen', settings.showFeedback) +
        (withRr ? checkHtml('atemKeepRr', 'RR-Rohdaten speichern (rund 8 KB je 20 min)', settings.keepRr) : '') +
      '</div>' +
      '<p class="atem-hint">Beim Einschalten kommt sofort ein Probehinweis. Der Ton folgt der Medienlautstärke des Handys.</p>' +
      '<label class="atem-field atem-field-wide"><span>Abendmodus</span><select class="atem-select" id="atemEvening">' +
        optionsHtml([{value:'auto', label:'Automatisch ab 19 Uhr'}, {value:'an', label:'An'}, {value:'aus', label:'Aus'}], settings.eveningMode) +
      '</select></label>');
  }
  function bindCueOptions(applyEvening){
    const byId = id => document.getElementById(id);
    function updateCueNote(){
      byId('atemCueNote').textContent = '· Ton ' + (settings.tone ? 'an' : 'aus') + ', Vibration ' + (settings.vibrate ? 'an' : 'aus');
    }
    byId('atemVibrate').disabled = !navigator.vibrate;
    byId('atemTone').addEventListener('change', e => {
      saveSetting('tone', e.target.checked);
      updateCueNote();
      if(e.target.checked) cues.tone(660, 0.4, 0.18);
    });
    byId('atemVibrate').addEventListener('change', e => {
      saveSetting('vibrate', e.target.checked);
      updateCueNote();
      if(e.target.checked) cues.vibrate(150);
    });
    byId('atemFeedback').addEventListener('change', e => saveSetting('showFeedback', e.target.checked));
    if(byId('atemKeepRr')) byId('atemKeepRr').addEventListener('change', e => saveSetting('keepRr', e.target.checked));
    byId('atemEvening').addEventListener('change', e => { saveSetting('eveningMode', e.target.value); applyEvening(); });
    updateCueNote();
  }

  /* ---------- Pacer-Lauf (Session und Resonanzfrequenz-Test) ----------
     Schritt: {label, kind:'pacer'|'rest', durationMs, pattern?, nextLabel, restLabel?}.
     onFinish erhält {ranges, hiddenMs}; ranges[i] ist null bei nie gestartetem Schritt. */
  function createStepRunner({root, steps, measuring, onFinish}){
    const byId = id => document.getElementById(id);
    let index = -1;
    let stepStart = 0;
    let lastPhaseKey = null;
    let hiddenMs = 0;
    let hiddenSince = document.visibilityState === 'hidden' ? performance.now() : null;
    let tickCount = 0;
    let active = true;
    let frameHandle = null;
    let tickTimer = null;
    const ranges = steps.map(() => null);

    function trackVisibility(){
      const now = performance.now();
      if(document.visibilityState === 'hidden') hiddenSince = now;
      else if(hiddenSince !== null){
        hiddenMs += now - hiddenSince;
        hiddenSince = null;
      }
      updateHints();
    }

    function updateHints(){
      if(!active) return;
      byId('atemRunLost').hidden = !(measuring && signal.status === 'unterbrochen');
      byId('atemRunWake').hidden = !wakeLock.failed;
      byId('atemRunHidden').hidden = hiddenMs < 1000;
    }

    function updateFeedbackVisibility(){
      byId('atemRunFeedback').hidden = !(measuring && settings.showFeedback);
      byId('atemRunToggle').hidden = !measuring;
      byId('atemRunToggle').textContent = settings.showFeedback ? 'Feedback ausblenden' : 'Feedback einblenden';
    }

    function enterStep(next){
      const now = performance.now();
      if(index >= 0) ranges[index] = {start:stepStart, end:now};
      if(next >= steps.length){ finish(); return; }
      if(index >= 0) cues.step();
      index = next;
      stepStart = now;
      lastPhaseKey = null;
      const step = steps[index];
      if(step.kind === 'pacer') sim.setBreathHz(step.pattern.bpm / 60, simAmplitudeScale(step.pattern.bpm));
      else sim.setBreathHz(0.25, 0.6);
      byId('atemRunStep').textContent = step.label;
      byId('atemRunNext').textContent = step.nextLabel;
      if(step.kind !== 'pacer'){
        byId('atemPacerLabel').textContent = step.restLabel || 'Normal atmen';
        byId('atemPacerCircle').dataset.kind = 'rest';
      }
    }

    function tick(){
      if(!active) return;
      const now = performance.now();
      const step = steps[index];
      const elapsed = now - stepStart;
      if(elapsed >= step.durationMs){ enterStep(index + 1); return; }
      byId('atemRunCountdown').textContent = fmtCountdown(step.durationMs - elapsed);
      if(step.kind === 'pacer'){
        const state = Core.pacerState(step.pattern, elapsed);
        const key = state.cycleIndex + ':' + state.phaseIndex;
        if(key !== lastPhaseKey){
          lastPhaseKey = key;
          cues.phase(state.kind);
          byId('atemPacerLabel').textContent = state.label;
          byId('atemPacerCircle').dataset.kind = state.kind;
        }
      }
      tickCount++;
      if(measuring && settings.showFeedback){
        if(tickCount % 3 === 0) redrawCurve(now);
        if(tickCount % 10 === 0) updateRsa(now);
      }
    }

    /* Rein zeitbasiert: Nach einer Verzögerung springt der Kreis an die richtige Stelle. */
    function frame(){
      if(!active) return;
      const step = steps[index];
      const level = step.kind === 'pacer' ? Core.pacerState(step.pattern, performance.now() - stepStart).level : 0.35;
      byId('atemPacerCircle').style.transform = 'scale(' + (0.42 + 0.58 * level).toFixed(4) + ')';
      frameHandle = requestAnimationFrame(frame);
    }

    function pacerRange(i, now){
      return i === index ? {start:stepStart, end:now} : ranges[i];
    }

    function redrawCurve(now){
      const from = now - CURVE_SPAN_MS;
      let bands = [];
      steps.forEach((step, i) => {
        const range = step.kind === 'pacer' ? pacerRange(i, now) : null;
        if(range && range.end > from) bands = bands.concat(Core.pacerBands(step.pattern, range.start, from, range.end));
      });
      drawHeartRateCurve(byId('atemRunCurve'), signal.pipeline.beats, now, bands);
    }

    function updateRsa(now){
      let i = index;
      while(i >= 0 && steps[i].kind !== 'pacer') i--;
      if(i < 0) return;
      const range = pacerRange(i, now);
      const end = i === index ? now - RSA_EVALUATION_DELAY_MS : range.end;
      const cycles = Core.pacerCycles(steps[i].pattern, range.start, end).slice(-RSA_TREND_CYCLES);
      const summary = Core.rsaSummary(signal.pipeline.beats.slice(-400), cycles);
      byId('atemRunRsa').textContent = summary.last === null ? '–' : fmt(summary.last, 1) + ' bpm';
      drawSparkline(byId('atemRunSpark'), summary.perCycle.filter(v => v !== null));
    }

    function teardown(){
      if(!active) return;
      active = false;
      clearInterval(tickTimer);
      cancelAnimationFrame(frameHandle);
      wakeLock.onChange = null;
      wakeLock.release();
      signal.listeners.delete(updateHints);
      document.removeEventListener('visibilitychange', trackVisibility);
      viewEl.classList.remove('atem-running');
    }

    function finish(){
      if(hiddenSince !== null) hiddenMs += performance.now() - hiddenSince;
      teardown();
      if(measuring) signal.pipeline.finish();
      onFinish({ranges, hiddenMs});
    }

    viewEl.classList.add('atem-running');
    viewEl.scrollTop = 0;
    root.innerHTML =
      '<div class="atem-run">' +
        '<div class="atem-run-head"><span id="atemRunStep"></span><span class="mono" id="atemRunCountdown"></span></div>' +
        '<div class="atem-pacer">' +
          '<div class="atem-pacer-circle" id="atemPacerCircle"></div>' +
          '<div class="atem-pacer-label" id="atemPacerLabel" aria-live="polite"></div>' +
        '</div>' +
        '<div class="atem-card atem-warning" id="atemRunLost" role="alert" hidden>' +
          '<p class="atem-hint">Gurtverbindung unterbrochen. Der Pacer läuft weiter.</p>' +
          '<button class="atem-btn" id="atemRunReconnect">Neu verbinden</button>' +
        '</div>' +
        '<p class="atem-hint" id="atemRunWake" hidden>Der Bildschirm konnte nicht angehalten werden. Stelle das Bildschirm-Timeout hoch genug ein.</p>' +
        '<p class="atem-hint" id="atemRunHidden" hidden>Der Bildschirm war zwischendurch aus. Dabei können Pacer und Hinweise ausgesetzt haben.</p>' +
        '<div class="atem-card" id="atemRunFeedback">' +
          '<canvas class="atem-curve atem-curve-small" id="atemRunCurve"></canvas>' +
          '<div class="atem-rsa-row" id="atemRunRsaRow"><div><div class="atem-rsa-value" id="atemRunRsa">–</div><div class="atem-rsa-label">RSA letzter Atemzyklus</div></div>' +
          '<canvas class="atem-spark" id="atemRunSpark"></canvas></div>' +
        '</div>' +
        '<div class="atem-actions atem-run-actions">' +
          '<button class="atem-btn" id="atemRunToggle"></button>' +
          '<button class="atem-btn" id="atemRunNext"></button>' +
        '</div>' +
      '</div>';
    byId('atemRunRsaRow').hidden = !steps.some(step => step.kind === 'pacer');
    byId('atemRunNext').addEventListener('click', () => enterStep(index + 1));
    byId('atemRunReconnect').addEventListener('click', () => ble.open());
    byId('atemRunToggle').addEventListener('click', () => {
      saveSetting('showFeedback', !settings.showFeedback);
      updateFeedbackVisibility();
    });
    updateFeedbackVisibility();
    wakeLock.onChange = updateHints;
    wakeLock.acquire();
    signal.listeners.add(updateHints);
    document.addEventListener('visibilitychange', trackVisibility);
    updateHints();
    enterStep(0);
    tickTimer = setInterval(tick, 100);
    frameHandle = requestAnimationFrame(frame);

    return {stop: teardown, isActive: () => active};
  }

  /* Der Simulator zeigt eine Resonanz bei 5,5/min, damit der Test etwas zu vergleichen hat. */
  function simAmplitudeScale(bpm){
    return Math.exp(-Math.pow((bpm - 5.5) / 1.2, 2));
  }

  /* ---------- Session ----------
     preset (optional): {technik, bpm, ie, durationMin, planId, unitId, title, hinweis} */
  function renderSessionView(root, preset){
    const byId = id => document.getElementById(id);
    let runner = null;
    let pending = null;   // abgeschlossene, noch nicht gespeicherte Session
    let tensionBefore = null;
    let detachSetup = null;
    let activePreset = preset;

    function applyEvening(){ viewEl.classList.toggle('atem-evening', eveningActive()); }

    /* ----- Vorbereitung ----- */
    function showSetup(){
      viewEl.classList.remove('atem-running');
      applyEvening();
      tensionBefore = null;
      const draft = activePreset
        ? {technik:activePreset.technik, bpm:activePreset.bpm, ie:activePreset.ie, durationMin:activePreset.durationMin}
        : {technik:'spb', bpm:settings.bpm, ie:settings.ie, durationMin:settings.durationMin};
      const durations = SESSION_MINUTES.includes(draft.durationMin)
        ? SESSION_MINUTES
        : SESSION_MINUTES.concat(draft.durationMin).sort((a, b) => a - b);
      const isSigh = draft.technik === 'sigh';

      root.innerHTML =
        (activePreset
          ? '<div class="atem-card atem-preset"><h3 class="atem-card-title">' + RT.escapeHtml(activePreset.title) + '</h3>' +
            (activePreset.hinweis ? '<p class="atem-hint">' + RT.escapeHtml(activePreset.hinweis) + '</p>' : '') + '</div>'
          : '') +
        connectionCardsHtml(true) +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">' + (isSigh ? 'Zyklisches Seufzen' : 'Atemmuster') + '</h3>' +
          '<div class="atem-fields">' +
            (isSigh ? '' :
              '<label class="atem-field"><span>Atemzüge/min</span><select class="atem-select" id="atemBpm">' +
                optionsHtml(Core.BPM_OPTIONS.map(bpm => ({value:bpm, label:fmtBpm(bpm)})), draft.bpm) + '</select></label>' +
              '<label class="atem-field"><span>Ein : Aus</span><select class="atem-select" id="atemIe">' +
                optionsHtml(Object.keys(Core.IE_OPTIONS).map(ie => ({value:ie, label:ie})), draft.ie) + '</select></label>') +
            '<label class="atem-field"><span>Dauer</span><select class="atem-select" id="atemDuration">' +
              optionsHtml(durations.map(min => ({value:min, label:min + ' min'})), draft.durationMin) + '</select></label>' +
          '</div>' +
          '<p class="atem-hint" id="atemPatternHint"></p>' +
          '<p class="atem-hint" id="atemRfNote" hidden></p>' +
        '</div>' +
        cueOptionsHtml(true) +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Wie angespannt bist du gerade?</h3>' +
          '<p class="atem-hint">0 = gar nicht, 10 = sehr stark. Optional.</p>' +
          scaleHtml('atemTensionBefore', 'Anspannung vorher') +
        '</div>' +
        '<button class="atem-btn primary atem-start" id="atemStart">Session starten</button>' +
        '<p class="atem-hint" id="atemStartHint"></p>';

      const updateConnection = bindConnectionCards();
      function updateSetup(){
        updateConnection();
        byId('atemStartHint').textContent = signalActive()
          ? 'Mit je 1 min Ruhemessung vorher und nachher. Beide lassen sich überspringen.'
          : 'Ohne Gurt läuft nur der Pacer, ohne Messwerte.';
      }
      function currentPattern(){
        return draft.technik === 'sigh' ? Core.buildSighPattern() : Core.buildBreathPattern(draft.bpm, draft.ie);
      }
      function updatePatternHint(){
        byId('atemPatternHint').textContent = isSigh
          ? 'Zwei Atemzüge nacheinander durch die Nase, dann lange durch den Mund ausatmen.'
          : fmt(currentPattern().phases[0].ms / 1000, 1) + ' s ein, ' + fmt(currentPattern().phases[1].ms / 1000, 1) + ' s aus';
      }
      // Eine geplante Einheit lässt sich anpassen, ändert aber nicht die eigenen Vorgaben.
      function changeDraft(key, value){
        draft[key] = value;
        if(!activePreset) saveSetting(key, value);
        updatePatternHint();
      }
      if(!isSigh){
        byId('atemBpm').addEventListener('change', e => changeDraft('bpm', Number(e.target.value)));
        byId('atemIe').addEventListener('change', e => changeDraft('ie', e.target.value));
      }
      byId('atemDuration').addEventListener('change', e => changeDraft('durationMin', Number(e.target.value)));
      bindCueOptions(applyEvening);
      bindScale('atemTensionBefore', value => { tensionBefore = value; });
      byId('atemStart').addEventListener('click', () => startRun(draft, currentPattern()));
      signal.listeners.add(updateSetup);
      detachSetup = () => signal.listeners.delete(updateSetup);
      updateSetup();
      updatePatternHint();
      if(!isSigh){
        latestRealRf().then(result => {
          const note = byId('atemRfNote');
          if(!note || !result || result.recommendedBpm === null) return;
          note.hidden = false;
          note.textContent = 'Dein Resonanzfrequenz-Test vom ' + fmtIsoDate(result.date) + ': ' + fmtBpm(result.recommendedBpm) + '/min.';
        });
      }
    }

    /* ----- Ablauf ----- */
    function startRun(draft, pattern){
      detachSetup();
      detachSetup = null;
      cues.prepare();
      const measuring = signalActive();
      if(measuring) signal.resetRecording();
      const startedAt = new Date();
      const plannedMs = draft.durationMin * 60000;
      const source = measuring ? signal.source : null;
      const pacerStep = {label:STEP_LABELS.pacer, kind:'pacer', durationMs:plannedMs, pattern, nextLabel:'Beenden'};
      const rest = label => ({label, kind:'rest', durationMs:REST_MEASUREMENT_MS, nextLabel:'Überspringen'});
      const steps = measuring ? [rest(STEP_LABELS.baseline), pacerStep, rest(STEP_LABELS.post)] : [pacerStep];
      const runTension = tensionBefore;
      runner = createStepRunner({
        root, steps, measuring,
        onFinish: ({ranges, hiddenMs}) => {
          runner = null;
          const rangeOf = step => { const i = steps.indexOf(step); return i >= 0 ? ranges[i] : null; };
          const pacerRange = rangeOf(pacerStep);
          const summary = Core.summarizeSession({
            beats: measuring ? signal.pipeline.beats : [],
            pattern,
            baseline: measuring ? ranges[0] : null,
            pacer: pacerRange,
            post: measuring ? ranges[2] : null
          });
          pending = {draft, pattern, plannedMs, source, measuring, startedAt, pacerRange, summary, hiddenMs, tensionBefore:runTension};
          showClosing();
        }
      });
    }

    /* ----- Abschluss ----- */
    function buildRecord(tensionAfter, note){
      const {draft, pattern, plannedMs, source, startedAt, pacerRange, summary, hiddenMs, tensionBefore:before} = pending;
      const segment = stats => stats && {
        rmssd: round2(stats.rmssd), lnRmssd: round2(stats.lnRmssd), hr: round2(stats.hr), beats: stats.beats
      };
      return {
        id: RT.uid(),
        startedAt: startedAt.toISOString(),
        date: RT.toISODate(startedAt),
        time: String(startedAt.getHours()).padStart(2, '0') + ':' + String(startedAt.getMinutes()).padStart(2, '0'),
        technik: draft.technik,
        planId: activePreset && activePreset.planId || null,
        unitId: activePreset && activePreset.unitId || null,
        bpm: round2(pattern.bpm),
        ie: pattern.ie,
        plannedMin: plannedMs / 60000,
        durationSec: pacerRange ? Math.round((pacerRange.end - pacerRange.start) / 1000) : 0,
        baseline: segment(summary.baseline),
        post: segment(summary.post),
        pacerRmssd: round2(summary.pacerRmssd),
        rsaMean: round2(summary.rsaMean),
        rsaCycles: summary.cycleCount,
        artefactRate: summary.artefactRate === null ? null : Math.round(summary.artefactRate * 10000) / 10000,
        artefactCount: summary.artefactCount,
        beatCount: summary.beatCount,
        quality: summary.quality,
        tensionBefore: before,
        tensionAfter,
        note,
        source,
        hiddenSec: Math.round(hiddenMs / 1000),
        hasRr: false
      };
    }

    function collectRrData(){
      return {
        rr: signal.pipeline.beats.map(b => Math.round(b.rr * 10) / 10),
        artefacts: signal.pipeline.beats.reduce((list, b, i) => {
          if(b.status !== 'ok') list.push(i);
          return list;
        }, [])
      };
    }

    function showClosing(){
      viewEl.scrollTop = 0;
      const {pattern, measuring, source, pacerRange, summary, tensionBefore:before} = pending;
      const durationMs = pacerRange ? pacerRange.end - pacerRange.start : 0;
      let tensionAfter = null;
      const measured = measuring && summary.beatCount > 0;
      const poorSignal = measured && summary.quality !== 'gut';
      root.innerHTML =
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Diese Session</h3>' +
          '<div class="atem-stats">' +
            stat('atemSumDuration', 'Dauer') + stat('atemSumPattern', 'Atemzüge/min') +
            (measured
              ? stat('atemSumRsa', 'RSA Mittel') +
                stat('atemSumBase', 'RMSSD vorher (ms)') + stat('atemSumPost', 'RMSSD nachher (ms)') +
                stat('atemSumQuality', 'Artefakte')
              : '') +
          '</div>' +
          (poorSignal ? '<p class="atem-hint" id="atemContactHint">Das Signal war gestört, die Werte sind daher nur eingeschränkt aussagekräftig. Meist liegt das am Gurtkontakt: Befeuchte die Elektroden und zieh den Gurt etwas fester.</p>' : '') +
          (source === 'sim' ? '<p class="atem-hint">Simulatordaten, keine echte Messung.</p>' : '') +
        '</div>' +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Wie angespannt bist du jetzt?</h3>' +
          '<p class="atem-hint">0 = gar nicht, 10 = sehr stark. Optional.' +
            (before !== null ? ' Vorher: ' + before + '.' : '') + '</p>' +
          scaleHtml('atemTensionAfter', 'Anspannung nachher') +
          '<label class="atem-field atem-field-wide"><span>Notiz (optional)</span><textarea class="atem-textarea" id="atemNote" rows="2"></textarea></label>' +
        '</div>' +
        '<p class="atem-error" id="atemSaveError" role="alert"></p>' +
        '<div class="atem-actions">' +
          '<button class="atem-btn primary" id="atemSave">Speichern</button>' +
          '<button class="atem-btn" id="atemExportPending" hidden>Als JSON sichern</button>' +
          '<button class="atem-btn" id="atemDiscard">Verwerfen</button>' +
        '</div>';

      byId('atemSumDuration').textContent = fmtCountdown(durationMs);
      byId('atemSumPattern').textContent = pending.draft.technik === 'sigh' ? 'Seufzen' : fmtBpm(pattern.bpm) + ' · ' + pattern.ie;
      if(measured){
        byId('atemSumRsa').textContent = summary.rsaMean === null ? '–' : fmt(summary.rsaMean, 1) + ' bpm';
        byId('atemSumBase').textContent = summary.baseline ? fmt(summary.baseline.rmssd, 1) : '–';
        byId('atemSumPost').textContent = summary.post ? fmt(summary.post.rmssd, 1) : '–';
        byId('atemSumQuality').textContent = fmt(summary.artefactRate * 100, 1) + ' % · ' + summary.quality;
        byId('atemSumQuality').style.color = QUALITY_COLORS[summary.quality];
      }
      bindScale('atemTensionAfter', value => { tensionAfter = value; });
      const currentRecord = () => buildRecord(tensionAfter, byId('atemNote').value.trim());

      byId('atemSave').addEventListener('click', async () => {
        const record = currentRecord();
        const rrData = settings.keepRr && measured ? collectRrData() : null;
        record.hasRr = !!rrData;
        try{
          await saveSession(record, rrData);
        }catch(e){
          byId('atemSaveError').textContent = 'Speichern fehlgeschlagen: ' + e.message + '. Sichere die Session als Datei, damit sie nicht verloren geht.';
          byId('atemExportPending').hidden = false;
          return;
        }
        pending = null;
        showSaved(record);
      });
      byId('atemExportPending').addEventListener('click', () => {
        RT.downloadJSON(currentRecord(), 'atmung-session-' + todayIso() + '.json');
      });
      byId('atemDiscard').addEventListener('click', () => {
        if(!confirm('Session verwerfen? Sie wird nicht gespeichert.')) return;
        pending = null;
        activePreset = null;
        showSetup();
      });
    }

    function showSaved(record){
      activePreset = null;
      const before = record.tensionBefore, after = record.tensionAfter;
      const tensionText = before !== null && after !== null ? ' Anspannung von ' + before + ' auf ' + after + '.' : '';
      root.innerHTML =
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Gespeichert</h3>' +
          '<p class="atem-hint">' + fmtCountdown(record.durationSec * 1000) + ' min bei ' + fmtBpm(record.bpm) + ' Atemzügen/min.' + tensionText + '</p>' +
          '<div class="atem-actions"><button class="atem-btn" id="atemAgain">Neue Session</button></div>' +
        '</div>';
      byId('atemAgain').addEventListener('click', showSetup);
    }

    showSetup();
    return {
      cleanup(){
        if(detachSetup) detachSetup();
        if(runner) runner.stop();
        runner = null;
        viewEl.classList.remove('atem-running', 'atem-evening');
      },
      beforeLeave(){
        if(runner) return confirm('Session abbrechen? Sie wird nicht gespeichert.');
        if(pending) return confirm('Session verwerfen? Sie ist noch nicht gespeichert.');
        return true;
      }
    };
  }

  /* ---------- Resonanzfrequenz-Test ---------- */
  async function loadRfResults(){
    const stored = await RT.store.get(RF_RESULTS_KEY);
    return stored ? JSON.parse(stored.value) : [];
  }

  /* Simulatorläufe dürfen die Pacer-Vorbelegung nicht verändern. */
  async function latestRealRf(){
    const results = await loadRfResults();
    const real = results.filter(r => r.source === 'ble' && r.recommendedBpm !== null);
    return real.length ? real[real.length - 1] : null;
  }

  function renderRfView(root, preset){
    const byId = id => document.getElementById(id);
    let runner = null;
    let detachSetup = null;

    function applyEvening(){ viewEl.classList.toggle('atem-evening', eveningActive()); }

    function showSetup(){
      viewEl.classList.remove('atem-running');
      applyEvening();
      const totalMin = (Core.RF_STEPS.length * Core.RF_STEP_MS + (Core.RF_STEPS.length - 1) * Core.RF_PAUSE_MS) / 60000;
      root.innerHTML =
        (preset ? '<div class="atem-card atem-preset"><h3 class="atem-card-title">' + RT.escapeHtml(preset.title) + '</h3></div>' : '') +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">So läuft der Test</h3>' +
          '<p class="atem-hint">Je 2 min Pacer bei ' + Core.RF_STEPS.map(fmtBpm).join(', ') + ' Atemzügen/min, dazwischen 30 s freie Atmung. Das dauert rund ' + totalMin + ' min. Der Vorschlag ist die Stufe mit der größten RSA-Amplitude.</p>' +
          '<p class="atem-hint">Der Test ist eine Option, keine Voraussetzung: Auch mit festen 6/min stieg die RMSSD in Studien (Laborde et al. 2022). Er bewertet nur die RSA und ist deshalb eine Vereinfachung, Details unter „Wissen“.</p>' +
        '</div>' +
        connectionCardsHtml(true) +
        cueOptionsHtml(false) +
        '<button class="atem-btn primary atem-start" id="atemRfStart">Test starten</button>' +
        '<p class="atem-hint" id="atemRfStartHint"></p>' +
        '<div id="atemRfHistory"></div>';

      const updateConnection = bindConnectionCards();
      function updateSetup(){
        updateConnection();
        byId('atemRfStart').disabled = !signalActive();
        byId('atemRfStartHint').textContent = signalActive() ? '' : 'Der Test braucht Messwerte: Verbinde zuerst den Gurt.';
      }
      bindCueOptions(applyEvening);
      byId('atemRfStart').addEventListener('click', startRun);
      signal.listeners.add(updateSetup);
      detachSetup = () => signal.listeners.delete(updateSetup);
      updateSetup();
      loadRfResults().then(results => {
        const holder = byId('atemRfHistory');
        if(!holder || !results.length) return;
        const latest = results[results.length - 1];
        holder.innerHTML = '<div class="atem-card"><h3 class="atem-card-title">Letzter Test</h3>' + resultHtml(latest) + '</div>';
      });
    }

    function startRun(){
      detachSetup();
      detachSetup = null;
      cues.prepare();
      signal.resetRecording();
      const source = signal.source;
      const startedAt = new Date();
      const steps = [];
      const pacerSteps = [];
      Core.RF_STEPS.forEach((bpm, i) => {
        const step = {
          label: 'Stufe ' + (i + 1) + ' von ' + Core.RF_STEPS.length + ' · ' + fmtBpm(bpm) + '/min',
          kind: 'pacer',
          durationMs: Core.RF_STEP_MS,
          pattern: Core.buildBreathPattern(bpm, '1:1'),
          nextLabel: 'Überspringen'
        };
        steps.push(step);
        pacerSteps.push(step);
        if(i < Core.RF_STEPS.length - 1){
          steps.push({label:'Pause', kind:'rest', durationMs:Core.RF_PAUSE_MS, restLabel:'Frei atmen', nextLabel:'Weiter'});
        }
      });
      runner = createStepRunner({
        root, steps, measuring:true,
        onFinish: ({ranges}) => {
          runner = null;
          const stepStats = pacerSteps.map(step => Core.rfStepStats(signal.pipeline.beats, step.pattern, ranges[steps.indexOf(step)]));
          finishTest(stepStats, startedAt, source);
        }
      });
    }

    async function finishTest(stepStats, startedAt, source){
      const evaluation = Core.evaluateRfSteps(stepStats);
      const result = {
        id: RT.uid(),
        startedAt: startedAt.toISOString(),
        date: RT.toISODate(startedAt),
        technik: 'rf-test',
        planId: preset && preset.planId || null,
        unitId: preset && preset.unitId || null,
        source,
        recommendedBpm: evaluation.recommendedBpm,
        alternativeBpm: evaluation.alternativeBpm,
        close: evaluation.close,
        steps: stepStats.map(step => ({
          bpm: step.bpm, rsaMean: round2(step.rsaMean), rmssd: round2(step.rmssd),
          artefactRate: step.artefactRate === null ? null : Math.round(step.artefactRate * 10000) / 10000,
          cycles: step.cycles, valid: step.valid
        }))
      };
      let saveError = null;
      try{
        const results = await loadRfResults();
        results.push(result);
        await RT.store.set(RF_RESULTS_KEY, JSON.stringify(results));
        if(source === 'ble' && result.recommendedBpm !== null) saveSetting('bpm', result.recommendedBpm);
      }catch(e){
        saveError = e.message;
      }
      viewEl.scrollTop = 0;
      root.innerHTML =
        '<div class="atem-card"><h3 class="atem-card-title">Ergebnis</h3>' + resultHtml(result) +
          (source === 'sim' ? '<p class="atem-hint">Simulatordaten: Das Ergebnis ändert deine Pacer-Vorgabe nicht.</p>' : '') +
        '</div>' +
        (saveError
          ? '<p class="atem-error" role="alert">Speichern fehlgeschlagen: ' + RT.escapeHtml(saveError) + '. Sichere das Ergebnis als Datei.</p>' +
            '<div class="atem-actions"><button class="atem-btn" id="atemRfExport">Als JSON sichern</button></div>'
          : '<p class="atem-hint" id="atemRfSaved">Gespeichert.</p>');
      if(saveError){
        byId('atemRfExport').addEventListener('click', () => RT.downloadJSON(result, 'atmung-rf-test-' + todayIso() + '.json'));
      }
    }

    function resultHtml(result){
      const best = result.recommendedBpm;
      let verdict;
      if(best === null){
        verdict = 'Zu wenige saubere Daten für einen Vorschlag. Befeuchte die Elektroden und wiederhole den Test.';
      } else if(result.close){
        verdict = fmtBpm(best) + ' und ' + fmtBpm(result.alternativeBpm) + ' Atemzüge/min liegen weniger als 10 % auseinander. Vorbelegt ist ' + fmtBpm(best) + '/min. Wiederhole den Test an einem anderen Tag, um das einzugrenzen.';
      } else {
        verdict = 'Die größte RSA-Amplitude lag bei ' + fmtBpm(best) + ' Atemzügen/min.';
      }
      const rows = result.steps.map(step =>
        '<tr' + (step.bpm === best ? ' class="atem-best"' : '') + '>' +
          '<td class="mono">' + fmtBpm(step.bpm) + '</td>' +
          '<td class="mono">' + (step.valid ? fmt(step.rsaMean, 1) : '–') + '</td>' +
          '<td class="mono">' + fmt(step.rmssd, 1) + '</td>' +
          '<td class="mono">' + (step.artefactRate === null ? '–' : fmt(step.artefactRate * 100, 1) + ' %') + '</td>' +
          '<td class="mono">' + step.cycles + '</td></tr>').join('');
      return '<p class="atem-hint" id="atemRfVerdict">' + fmtIsoDate(result.date) + ': ' + verdict + '</p>' +
        '<div class="table-scroll atem-beats"><table class="history-table" id="atemRfTable"><thead><tr><th>/min</th><th>RSA (bpm)</th><th>RMSSD</th><th>Artefakte</th><th>Zyklen</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    showSetup();
    return {
      cleanup(){
        if(detachSetup) detachSetup();
        if(runner) runner.stop();
        runner = null;
        viewEl.classList.remove('atem-running', 'atem-evening');
      },
      beforeLeave(){
        return runner ? confirm('Test abbrechen? Er wird nicht gespeichert.') : true;
      }
    };
  }

  /* ---------- Trainingspläne ---------- */
  const TIME_LABELS = {morgen:'morgens', abend:'abends', frei:''};
  const QUICK_STARTS = [
    {
      id: 'akut-sigh',
      title: 'Akut: Zyklisches Seufzen',
      text: '5 min. Täglich geübt besserte es die Stimmung stärker als Meditation (Balban et al. 2023); vor Wettkämpfen nicht untersucht.',
      preset: {technik:'sigh', bpm:null, ie:null, durationMin:5, title:'Akut: Zyklisches Seufzen', hinweis:'Doppelte Einatmung durch die Nase, lange Ausatmung durch den Mund.'}
    },
    {
      id: 'akut-spb',
      title: 'Akut: Langsam atmen',
      text: 'Die Alternative: 5 min bei 6 Atemzügen/min.',
      preset: {technik:'spb', bpm:6, ie:'1:1', durationMin:5, title:'Akut: Langsam atmen', hinweis:''}
    },
    {
      id: 'regeneration',
      title: 'Regeneration nach dem Training',
      text: '10 min bei 6 Atemzügen/min nach harten Einheiten.',
      preset: {technik:'spb', bpm:6, ie:'1:1', durationMin:10, title:'Regeneration nach dem Training', hinweis:'Die Evidenz für einen Leistungseffekt ist schwächer als für Stress und Wohlbefinden.'}
    }
  ];

  function unitLabel(unit, rfBpm){
    const time = TIME_LABELS[unit.zeit] ? TIME_LABELS[unit.zeit] + ' · ' : '';
    if(unit.technik === 'rf-test') return time + 'Resonanzfrequenz-Test';
    if(unit.technik === 'morgen-hrv') return time + 'Morgen-HRV';
    if(unit.technik === 'sigh') return time + unit.dauerMin + ' min zyklisches Seufzen';
    const frequency = unit.frequenz === 'rf'
      ? 'persönliche Frequenz (' + fmtBpm(Core.resolveFrequency('rf', rfBpm)) + '/min' + (rfBpm ? '' : ', noch kein Test') + ')'
      : fmtBpm(unit.frequenz) + '/min';
    return time + unit.dauerMin + ' min bei ' + frequency;
  }

  function launchPlanUnit(plan, startDate, unitId, rfBpm){
    const weekIndex = Core.planWeekIndex(startDate, todayIso());
    const unit = plan.weeks[weekIndex].sessions.find(u => u.id === unitId);
    const link = {planId:plan.id, unitId:unit.id, title:plan.name + ' · Woche ' + (weekIndex + 1)};
    if(unit.technik === 'rf-test') launchView('rf', link);
    else if(unit.technik === 'morgen-hrv') launchView('morgen', link);
    else if(unit.technik === 'sigh') launchView('session', Object.assign({technik:'sigh', bpm:null, ie:null, durationMin:unit.dauerMin, hinweis:unit.hinweis}, link));
    else launchView('session', Object.assign({
      technik: 'spb',
      bpm: Core.resolveFrequency(unit.frequenz, rfBpm),
      ie: unit.ie,
      durationMin: unit.dauerMin,
      hinweis: unit.hinweis
    }, link));
  }

  function triggerSentence(trigger){
    return 'Wenn ' + trigger + ', dann starte ich die Atem-Session.';
  }

  /* Alles, was eine Plan-Einheit als erledigt markieren kann. */
  async function loadPlanRecords(){
    const [sessions, rfResults, morning] = await Promise.all([loadSessions(), loadRfResults(), loadMorning()]);
    return sessions.concat(rfResults, morning);
  }

  async function loadPlans(){
    const stored = await RT.store.get(PLANS_KEY);
    if(stored) return JSON.parse(stored.value);
    // Nur beim allerersten Mal anlegen: Gelöschte Standardpläne kommen nicht zurück.
    await RT.store.set(PLANS_KEY, JSON.stringify(Core.STANDARD_PLANS));
    return JSON.parse(JSON.stringify(Core.STANDARD_PLANS));
  }
  async function savePlans(plans){ await RT.store.set(PLANS_KEY, JSON.stringify(plans)); }
  async function loadActivePlan(){
    const stored = await RT.store.get(ACTIVE_PLAN_KEY);
    return stored ? JSON.parse(stored.value) : null;
  }
  function uniquePlanId(plans, wanted){
    const safe = String(wanted || '').replace(/[^A-Za-z0-9_-]/g, '');
    return safe && !plans.some(p => p.id === safe) ? safe : 'plan-' + RT.uid();
  }

  /* Liest nur: Sagt, ob heute im aktiven Radblock eine harte Einheit abgehakt wurde. */
  async function hardTrainingToday(){
    try{
      const activeId = await RT.store.get('active-block-id');
      if(!activeId) return null;
      const [blockRaw, logRaw] = await Promise.all([RT.store.get('block:' + activeId.value), RT.store.get('log:' + activeId.value)]);
      if(!blockRaw || !logRaw) return null;
      const block = JSON.parse(blockRaw.value), log = JSON.parse(logRaw.value), today = todayIso();
      for(const week of block.weeks || []){
        for(const session of week.sessions || []){
          const entry = log.entries && log.entries[session.id];
          if(entry && entry.done && entry.date === today && HARD_TRAINING_TAGS.includes(session.tag)) return session.title;
        }
      }
    }catch(e){
      console.error('Atmung: Radtraining nicht lesbar', e);
    }
    return null;
  }

  function renderPlansView(root){
    const holder = document.createElement('div');
    root.innerHTML = '';
    root.appendChild(holder);
    let plans = [], active = null, activePlan = null, records = [], rfBpm = null, hardToday = null;
    let errorText = '', editingId = null;
    // Bleiben bei Fehlern erhalten: Neuzeichnen darf eingegebenen Text nicht verwerfen.
    let editorDraft = null, pasteDraft = '';

    function dayPart(unit){
      return unit.tag === 'einmalig' ? 'einmal diese Woche' : 'täglich';
    }

    function activeCardHtml(){
      if(!activePlan) return '<div class="atem-card"><h3 class="atem-card-title">Aktueller Plan</h3><p class="atem-hint">Kein Plan aktiv. Du kannst unten einen aktivieren oder frei üben.</p></div>';
      const today = todayIso();
      const weekIndex = Core.planWeekIndex(active.startDate, today);
      const count = activePlan.weeks.length;
      let body;
      if(weekIndex < 0){
        body = '<p class="atem-hint">Beginnt am ' + fmtIsoDate(active.startDate) + '.</p>';
      } else if(weekIndex >= count){
        body = '<p class="atem-hint">Der Plan ist durchlaufen. Du kannst ihn beenden oder einen neuen wählen.</p>';
      } else {
        const progress = Core.weekProgress(activePlan, active.startDate, weekIndex, records);
        const units = Core.unitsForDay(activePlan, active.startDate, today, records);
        body = '<p class="atem-hint" id="atemPlanProgress">Woche ' + (weekIndex + 1) + ' von ' + count + ' · diese Woche ' + progress.done + ' von ' + progress.planned + ' Einheiten</p>' +
          (activePlan.weeks[weekIndex].weekNote ? '<p class="atem-hint">' + RT.escapeHtml(activePlan.weeks[weekIndex].weekNote) + '</p>' : '') +
          '<div class="atem-units" id="atemTodayUnits">' + (units.length ? units.map(item =>
            '<div class="atem-unit' + (item.done ? ' done' : '') + '">' +
              '<div><div class="atem-unit-title">' + RT.escapeHtml(unitLabel(item.unit, rfBpm)) + '</div>' +
              (item.unit.hinweis ? '<div class="atem-muted">' + RT.escapeHtml(item.unit.hinweis) + '</div>' : '') + '</div>' +
              (item.done
                ? '<span class="atem-unit-done">erledigt</span>'
                : '<button class="atem-btn primary" data-action="start-unit" data-unit="' + item.unit.id + '">Start</button>') +
            '</div>').join('') : '<p class="atem-hint">Heute steht nichts an.</p>') + '</div>';
      }
      const overview = activePlan.weeks.map((week, i) => {
        const progress = Core.weekProgress(activePlan, active.startDate, i, records);
        return '<li class="' + (i === weekIndex ? 'current' : '') + '"><strong>Woche ' + (i + 1) + '</strong> <span class="atem-muted">' + progress.done + ' von ' + progress.planned + '</span>' +
          '<div class="atem-muted">' + week.sessions.map(unit => RT.escapeHtml(unitLabel(unit, rfBpm) + ', ' + dayPart(unit))).join('<br>') + '</div></li>';
      }).join('');
      return '<div class="atem-card" id="atemActivePlan"><h3 class="atem-card-title">Aktueller Plan</h3>' +
        '<div class="atem-plan-name">' + RT.escapeHtml(activePlan.name) + '</div>' + body +
        '<div class="atem-trigger' + (active.trigger ? '' : ' empty') + '" id="atemTrigger">' +
          (active.trigger ? '<p class="atem-hint" id="atemTriggerSentence">' + RT.escapeHtml(triggerSentence(active.trigger)) + '</p>' : '<p class="atem-hint">Lege fest, woran du die Übung knüpfst. Solche Wenn-Dann-Pläne helfen, Vorsätze umzusetzen (Gollwitzer &amp; Sheeran 2006).</p>') +
          '<label class="atem-field"><span>Wenn …</span><input class="atem-select" type="text" id="atemTriggerInput" maxlength="120" placeholder="ich abends ins Bett gehe" value="' + RT.escapeHtml(active.trigger || '') + '"></label>' +
          '<div class="atem-muted">… dann starte ich die Atem-Session.</div>' +
        '</div>' +
        '<details class="atem-week-overview"><summary>Wochenübersicht</summary><ol class="atem-weeks">' + overview + '</ol></details>' +
        '<div class="atem-actions atem-plan-actions">' +
          '<label class="atem-field"><span>Startdatum</span><input class="atem-select" type="date" id="atemPlanStart" value="' + active.startDate + '"></label>' +
          '<button class="atem-btn" data-action="deactivate">Plan beenden</button>' +
        '</div></div>';
    }

    function quickStartsHtml(){
      return '<div class="atem-card"><h3 class="atem-card-title">Schnellstart</h3><div class="atem-quick">' +
        QUICK_STARTS.map(quick =>
          '<button class="atem-quick-item" data-action="quick" data-quick="' + quick.id + '">' +
            '<span class="atem-unit-title">' + RT.escapeHtml(quick.title) + '</span>' +
            '<span class="atem-muted">' + RT.escapeHtml(quick.text) + '</span>' +
            (quick.id === 'regeneration' && hardToday ? '<span class="atem-quick-note" id="atemHardToday">Heute abgehakt: ' + RT.escapeHtml(hardToday) + '</span>' : '') +
          '</button>').join('') + '</div></div>';
    }

    function planListHtml(){
      const items = plans.map(plan => {
        const id = RT.escapeHtml(plan.id);
        const isActive = active && active.planId === plan.id;
        return '<div class="atem-plan" data-plan="' + id + '">' +
          '<div class="atem-plan-name">' + RT.escapeHtml(plan.name) + (isActive ? ' <span class="atem-unit-done">aktiv</span>' : '') + '</div>' +
          '<div class="atem-muted">' + plan.weeks.length + ' ' + (plan.weeks.length === 1 ? 'Woche' : 'Wochen') + (plan.quelle ? ' · ' + RT.escapeHtml(plan.quelle) : '') + '</div>' +
          '<div class="atem-actions">' +
            (isActive ? '' : '<button class="atem-btn" data-action="activate" data-id="' + id + '">Aktivieren</button>') +
            '<button class="atem-btn" data-action="edit" data-id="' + id + '">Bearbeiten</button>' +
            '<button class="atem-btn" data-action="duplicate" data-id="' + id + '">Duplizieren</button>' +
            '<button class="atem-btn" data-action="export" data-id="' + id + '">Exportieren</button>' +
            '<button class="atem-btn atem-danger" data-action="delete" data-id="' + id + '">Löschen</button>' +
          '</div>' +
          (editingId === plan.id
            ? '<div class="atem-editor"><textarea class="atem-textarea mono" id="atemPlanEditor" rows="12" aria-label="Plan als JSON">' + RT.escapeHtml(editorDraft !== null ? editorDraft : JSON.stringify(plan, null, 2)) + '</textarea>' +
              '<div class="atem-actions"><button class="atem-btn primary" data-action="save-edit" data-id="' + id + '">Änderungen speichern</button><button class="atem-btn" data-action="cancel-edit">Abbrechen</button></div></div>'
            : '') +
        '</div>';
      }).join('');
      return '<div class="atem-card"><h3 class="atem-card-title">Alle Pläne</h3>' +
        (items || '<p class="atem-hint">Noch keine Pläne.</p>') + '</div>';
    }

    function importHtml(){
      return foldableCard('Plan importieren', true,
        '<p class="atem-hint">Als JSON-Datei oder eingefügter Text. Schema: {name, quelle?, weeks:[{weekNote?, sessions:[{tag, zeit, technik, frequenz, ie, dauerMin, hinweis}]}]}. tag: taeglich, einmalig. zeit: morgen, abend, frei. technik: spb, rf-test, sigh, morgen-hrv. frequenz: Wert von 4,5 bis 7 oder "rf".</p>' +
        '<div class="atem-actions"><button class="atem-btn" data-action="pick-file">Datei wählen</button>' +
        '<input type="file" id="atemPlanFile" accept="application/json,.json" hidden></div>' +
        '<textarea class="atem-textarea mono atem-field-wide" id="atemPlanPaste" rows="6" aria-label="Plan als JSON einfügen" placeholder="JSON hier einfügen"></textarea>' +
        '<div class="atem-actions"><button class="atem-btn" data-action="import-text">Importieren</button></div>');
    }

    function render(){
      if(!holder.isConnected) return;
      holder.innerHTML = activeCardHtml() + quickStartsHtml() +
        '<p class="atem-error" id="atemPlanError" role="alert">' + RT.escapeHtml(errorText) + '</p>' +
        planListHtml() + importHtml();
      const startInput = holder.querySelector('#atemPlanStart');
      if(startInput) startInput.addEventListener('change', e => changeStartDate(e.target.value));
      const triggerInput = holder.querySelector('#atemTriggerInput');
      if(triggerInput) triggerInput.addEventListener('change', e => change(() => RT.store.set(ACTIVE_PLAN_KEY, JSON.stringify(Object.assign({}, active, {trigger:e.target.value.trim()})))));
      holder.querySelector('#atemPlanFile').addEventListener('change', importFile);
      if(pasteDraft){
        const paste = holder.querySelector('#atemPlanPaste');
        paste.value = pasteDraft;
        paste.closest('details').open = true;
      }
    }

    async function refresh(){
      try{
        const [loadedPlans, loadedActive, loadedRecords, latest, hard] = await Promise.all([
          loadPlans(), loadActivePlan(), loadPlanRecords(), latestRealRf(), hardTrainingToday()
        ]);
        plans = loadedPlans;
        active = loadedActive;
        activePlan = active ? plans.find(p => p.id === active.planId) || null : null;
        records = loadedRecords;
        rfBpm = latest ? latest.recommendedBpm : null;
        hardToday = hard;
      }catch(e){
        errorText = 'Pläne konnten nicht geladen werden: ' + e.message;
      }
      render();
    }

    /* Führt eine Speicheraktion aus und zeigt Fehler an, statt sie zu verschlucken. */
    async function change(action){
      errorText = '';
      try{
        await action();
      }catch(e){
        errorText = 'Speichern fehlgeschlagen: ' + e.message;
      }
      await refresh();
    }

    async function changeStartDate(value){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
      await change(() => RT.store.set(ACTIVE_PLAN_KEY, JSON.stringify(Object.assign({}, active, {startDate:value}))));
    }

    function addImportedPlan(text){
      let parsed;
      try{ parsed = JSON.parse(text); }
      catch(e){ errorText = 'JSON ist nicht gültig: ' + e.message; render(); return false; }
      const problem = Core.validatePlan(parsed);
      if(problem){ errorText = problem; render(); return false; }
      pasteDraft = '';
      change(async () => {
        const plan = Core.normalizePlan(parsed, uniquePlanId(plans, parsed.id));
        await savePlans(plans.concat(plan));
      });
      return true;
    }

    async function importFile(event){
      const file = event.target.files[0];
      event.target.value = '';
      if(!file) return;
      let text;
      try{ text = await file.text(); }
      catch(e){ errorText = 'Datei konnte nicht gelesen werden.'; render(); return; }
      addImportedPlan(text);
    }

    holder.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if(!button) return;
      const id = button.dataset.id;
      const plan = plans.find(p => p.id === id);
      switch(button.dataset.action){
        case 'start-unit': launchPlanUnit(activePlan, active.startDate, button.dataset.unit, rfBpm); break;
        case 'quick': launchView('session', QUICK_STARTS.find(q => q.id === button.dataset.quick).preset); break;
        case 'activate':
          change(() => RT.store.set(ACTIVE_PLAN_KEY, JSON.stringify({planId:id, startDate:todayIso(), trigger:''})));
          break;
        case 'deactivate':
          if(confirm('Plan beenden? Deine Sessions bleiben erhalten.')) change(() => RT.store.delete(ACTIVE_PLAN_KEY));
          break;
        case 'duplicate':
          change(() => savePlans(plans.concat(Object.assign(JSON.parse(JSON.stringify(plan)), {id:'plan-' + RT.uid(), name:plan.name + ' (Kopie)'}))));
          break;
        case 'export':
          RT.downloadJSON(plan, 'atmung-plan-' + plan.id + '.json');
          break;
        case 'delete':
          if(!confirm('Plan "' + plan.name + '" löschen? Deine Sessions bleiben erhalten.')) return;
          change(async () => {
            await savePlans(plans.filter(p => p.id !== id));
            if(active && active.planId === id) await RT.store.delete(ACTIVE_PLAN_KEY);
          });
          break;
        case 'edit':
          editingId = editingId === id ? null : id;
          editorDraft = null;
          errorText = '';
          render();
          break;
        case 'cancel-edit':
          editingId = null;
          editorDraft = null;
          errorText = '';
          render();
          break;
        case 'save-edit': {
          editorDraft = holder.querySelector('#atemPlanEditor').value;
          let parsed;
          try{ parsed = JSON.parse(editorDraft); }
          catch(e){ errorText = 'JSON ist nicht gültig: ' + e.message; render(); return; }
          const problem = Core.validatePlan(parsed);
          if(problem){ errorText = problem; render(); return; }
          editingId = null;
          editorDraft = null;
          change(() => savePlans(plans.map(p => p.id === id ? Core.normalizePlan(parsed, id) : p)));
          break;
        }
        case 'pick-file': holder.querySelector('#atemPlanFile').click(); break;
        case 'import-text': {
          pasteDraft = holder.querySelector('#atemPlanPaste').value;
          addImportedPlan(pasteDraft);
          break;
        }
      }
    });

    refresh();
  }

  /* ---------- Diagramme ---------- */
  /* Für dunkle Flächen geprüft (Helligkeit, Sättigung, Farbfehlsichtigkeit, Kontrast).
     Die helleren App-Farben fallen als Diagrammlinien durch diese Prüfung. */
  const CHART_BLUE = '#3987e5';
  const CHART_AMBER = '#c98500';
  function cssToken(name){
    return getComputedStyle(viewEl).getPropertyValue(name).trim();
  }
  function fmtShortDate(iso){
    const parts = iso.split('-');
    return parts[2] + '.' + parts[1] + '.';
  }
  function chartHtml(id, title){
    return '<div class="atem-card"><h3 class="atem-card-title">' + title + '</h3>' +
      '<div class="atem-chart"><canvas id="' + id + '" role="img" aria-label="' + title + '"></canvas></div>' +
      '<p class="atem-hint" id="' + id + 'Empty" hidden>Noch keine Daten.</p></div>';
  }
  /* Eigene Chart.js-Instanzen: Die Diagramme des Radtrainings werden getrennt verwaltet. */
  function createChartSet(){
    const charts = [];
    return {
      draw(id, labels, datasets, options){
        const canvas = document.getElementById(id);
        const hasData = datasets.some(set => set.data.some(v => v !== null && v !== undefined));
        document.getElementById(id + 'Empty').hidden = hasData;
        canvas.parentElement.hidden = !hasData;
        if(!hasData) return;
        if(typeof Chart === 'undefined'){
          const note = document.getElementById(id + 'Empty');
          note.hidden = false;
          note.textContent = 'Das Diagramm konnte nicht geladen werden.';
          canvas.parentElement.hidden = true;
          return;
        }
        const grid = cssToken('--line-soft'), ink = cssToken('--ink-dim');
        charts.push(new Chart(canvas, {
          type: options.type || 'line',
          data: {labels, datasets},
          options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {mode:'index', intersect:false},
            plugins: {
              legend: {display: datasets.length >= 2, labels: {color:ink, boxWidth:12, boxHeight:2, filter: item => !item.text.startsWith('_')}},
              tooltip: {filter: item => !item.dataset.label.startsWith('_')}
            },
            scales: {
              x: {grid:{display:false}, ticks:{color:ink, maxRotation:0, autoSkipPadding:14}},
              y: Object.assign({grid:{color:grid}, ticks:{color:ink}, title:{display:!!options.yTitle, text:options.yTitle, color:ink}}, options.y || {})
            }
          }
        }));
      },
      destroy(){
        charts.forEach(chart => chart.destroy());
        charts.length = 0;
      }
    };
  }
  function lineDataset(label, data, color, extra){
    return Object.assign({label, data, borderColor:color, backgroundColor:color, borderWidth:2, pointRadius:4, pointHoverRadius:5, tension:0, spanGaps:true}, extra);
  }

  /* ---------- Verlauf ---------- */
  const TECHNIK_LABELS = {spb:'Langsames Atmen', sigh:'Zyklisches Seufzen', 'rf-test':'Resonanzfrequenz-Test'};
  const HEATMAP_WEEKS = 12;
  const MINUTES_CHART_WEEKS = 12;
  const WEEKLY_GOAL_OPTIONS = [3, 4, 5, 6, 7];

  function renderHistoryView(root){
    const byId = id => document.getElementById(id);
    const chartSet = createChartSet();
    let sessions = [], rfResults = [], plans = [];
    let filterTechnik = '', filterPlan = '', showSimulated = false;
    let loadError = '';

    root.innerHTML = '<div id="atemHistoryBody"><p class="atem-hint">Lädt…</p></div>';

    function practiceRecords(){
      return sessions.concat(rfResults).filter(r => showSimulated || r.source !== 'sim');
    }
    function filteredSessions(){
      return sessions.filter(s =>
        (showSimulated || s.source !== 'sim') &&
        (!filterTechnik || s.technik === filterTechnik) &&
        (!filterPlan || (filterPlan === '-' ? !s.planId : s.planId === filterPlan)));
    }

    function summarySentences(records, today){
      const lines = [];
      const describe = (name, unit, digits, pick) => {
        const {current, previous} = Core.weeklyComparison(records, today, pick);
        if(current === null) return;
        lines.push('Deine ' + name + ' lag diese Woche im Schnitt bei ' + fmt(current, digits) + ' ' + unit +
          (previous === null ? '.' : ', Vorwoche ' + fmt(previous, digits) + ' ' + unit + '.'));
      };
      describe('RSA-Amplitude', 'bpm', 1, s => s.rsaMean);
      describe('RMSSD vor der Session', 'ms', 1, s => s.baseline ? s.baseline.rmssd : null);
      const both = records.filter(s => s.tensionBefore !== null && s.tensionBefore !== undefined && s.tensionAfter !== null && s.tensionAfter !== undefined);
      if(both.length){
        const mean = pick => both.reduce((sum, s) => sum + pick(s), 0) / both.length;
        lines.push('Anspannung im Schnitt von ' + fmt(mean(s => s.tensionBefore), 1) + ' vorher auf ' + fmt(mean(s => s.tensionAfter), 1) + ' nachher, aus ' + both.length + ' ' + (both.length === 1 ? 'Session' : 'Sessions') + '.');
      }
      return lines;
    }

    function heatmapHtml(records, today){
      const columns = Core.practiceHeatmap(records, today, HEATMAP_WEEKS);
      const max = Math.max(20, ...columns.flat().map(day => day.minutes));
      const dayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
      const labels = '<div class="atem-heat-labels">' + dayNames.map(name => '<span>' + name + '</span>').join('') + '</div>';
      const cells = columns.map(week =>
        '<div class="atem-heat-col">' + week.map(day => {
          const label = fmtIsoDate(day.date) + ': ' + (day.minutes ? Math.round(day.minutes) + ' min' : 'keine Übung');
          if(day.future) return '<span class="atem-heat-cell future"></span>';
          const level = day.minutes ? 0.3 + 0.7 * Math.min(1, day.minutes / max) : 0;
          return '<span class="atem-heat-cell" title="' + label + '" aria-label="' + label + '" role="img"' + (level ? ' style="background:rgba(57,135,229,' + level.toFixed(2) + ')"' : '') + '></span>';
        }).join('') + '</div>').join('');
      return '<div class="atem-heat">' + labels + '<div class="atem-heat-grid">' + cells + '</div></div>' +
        '<p class="atem-hint">Kräftiger ist mehr Übungszeit. Ein ausgelassener Tag stört den Gewohnheitsaufbau kaum: Im Mittel brauchten Gewohnheiten rund 66 Tage, die Spanne reichte von 18 bis 254 (Lally et al. 2010).</p>';
    }

    function listHtml(list){
      const planName = id => {
        const plan = plans.find(p => p.id === id);
        return plan ? plan.name : '';
      };
      const rows = list.slice().reverse().slice(0, 60).map(s =>
        '<tr><td class="mono">' + fmtShortDate(s.date) + (s.time ? ' ' + RT.escapeHtml(s.time) : '') + '</td>' +
        '<td>' + RT.escapeHtml(TECHNIK_LABELS[s.technik] || s.technik) + (s.source === 'sim' ? ' <span class="atem-muted">(Simulator)</span>' : '') +
          (s.planId ? '<div class="atem-muted">' + RT.escapeHtml(planName(s.planId)) + '</div>' : '') +
          (s.note ? '<div class="atem-muted">' + RT.escapeHtml(s.note) + '</div>' : '') + '</td>' +
        '<td class="mono">' + (s.bpm ? fmtBpm(s.bpm) : '–') + '</td>' +
        '<td class="mono">' + Math.round(Core.recordMinutes(s)) + '</td>' +
        '<td class="mono">' + fmt(s.rsaMean, 1) + '</td>' +
        '<td class="mono">' + (s.quality ? RT.escapeHtml(s.quality) : '–') + '</td></tr>').join('');
      return rows
        ? '<div class="table-scroll atem-list"><table class="history-table"><thead><tr><th>Datum</th><th>Einheit</th><th>/min</th><th>min</th><th>RSA</th><th>Signal</th></tr></thead><tbody id="atemHistoryRows">' + rows + '</tbody></table></div>' +
          (list.length > 60 ? '<p class="atem-hint">Die letzten 60 von ' + list.length + '. Alle stehen im Export.</p>' : '')
        : '<p class="atem-hint" id="atemHistoryNone">Keine passenden Sessions.</p>';
    }

    function drawCharts(list, records, today){
      chartSet.destroy();
      const labels = list.map(s => fmtShortDate(s.date));
      const accent = CHART_BLUE, second = CHART_AMBER;
      chartSet.draw('atemChartRsa', labels, [lineDataset('RSA', list.map(s => s.rsaMean), accent)], {yTitle:'bpm'});
      chartSet.draw('atemChartRmssd', labels, [lineDataset('RMSSD', list.map(s => s.baseline ? s.baseline.rmssd : null), accent)], {yTitle:'ms'});
      chartSet.draw('atemChartTension', labels, [
        lineDataset('Vorher', list.map(s => s.tensionBefore), second),
        lineDataset('Nachher', list.map(s => s.tensionAfter), accent)
      ], {y:{min:0, max:10}});
      const weeks = Core.minutesPerWeek(records, today, MINUTES_CHART_WEEKS);
      chartSet.draw('atemChartMinutes', weeks.map(w => fmtShortDate(w.weekStart)),
        [{label:'Minuten', data:weeks.map(w => Math.round(w.minutes)), backgroundColor:accent, borderRadius:4, maxBarThickness:18}],
        {type:'bar', yTitle:'min', y:{beginAtZero:true}});
    }

    function render(){
      const holder = byId('atemHistoryBody');
      if(!holder) return;
      const today = todayIso();
      const records = practiceRecords();
      const list = filteredSessions();
      const total = records.reduce((sum, r) => sum + Core.recordMinutes(r), 0);
      const activeDays = Core.weekActiveDays(records, today);
      const lines = summarySentences(list, today);
      const planOptions = [{value:'', label:'Alle'}, {value:'-', label:'Ohne Plan'}]
        .concat(plans.map(p => ({value:RT.escapeHtml(p.id), label:RT.escapeHtml(p.name)})));
      holder.innerHTML =
        (loadError ? '<p class="atem-error" role="alert">' + RT.escapeHtml(loadError) + '</p>' : '') +
        '<div class="atem-card">' +
          '<div class="atem-stats atem-stats-two">' +
            '<div class="field"><div class="v atem-stat-value" id="atemWeekDays">' + activeDays + ' von ' + settings.weeklyGoal + '</div><div class="l">Tage diese Woche</div></div>' +
            '<div class="field"><div class="v atem-stat-value" id="atemTotalMinutes">' + Math.round(total) + '</div><div class="l">Minuten gesamt</div></div>' +
          '</div>' +
          '<label class="atem-field atem-field-wide"><span>Wochenziel</span><select class="atem-select" id="atemWeeklyGoal">' +
            optionsHtml(WEEKLY_GOAL_OPTIONS.map(v => ({value:v, label:v + ' von 7 Tagen'})), settings.weeklyGoal) + '</select></label>' +
          (lines.length ? '<ul class="atem-summary" id="atemSummary">' + lines.map(line => '<li>' + RT.escapeHtml(line) + '</li>').join('') + '</ul>' : '') +
        '</div>' +
        '<div class="atem-card"><h3 class="atem-card-title">Letzte 12 Wochen</h3>' + heatmapHtml(records, today) + '</div>' +
        '<div class="atem-card">' +
          '<div class="atem-fields atem-fields-two">' +
            '<label class="atem-field"><span>Technik</span><select class="atem-select" id="atemFilterTechnik">' +
              optionsHtml([{value:'', label:'Alle'}, {value:'spb', label:TECHNIK_LABELS.spb}, {value:'sigh', label:TECHNIK_LABELS.sigh}], filterTechnik) + '</select></label>' +
            '<label class="atem-field"><span>Plan</span><select class="atem-select" id="atemFilterPlan">' + optionsHtml(planOptions, filterPlan) + '</select></label>' +
          '</div>' +
          '<div class="atem-checks">' + checkHtml('atemShowSim', 'Simulatordaten einbeziehen', showSimulated) + '</div>' +
        '</div>' +
        chartHtml('atemChartRsa', 'RSA-Amplitude je Session') +
        chartHtml('atemChartRmssd', 'RMSSD vor der Session') +
        chartHtml('atemChartTension', 'Anspannung vorher und nachher') +
        chartHtml('atemChartMinutes', 'Minuten pro Woche') +
        '<div class="atem-card"><h3 class="atem-card-title">Sessions</h3>' + listHtml(list) +
          '<div class="atem-actions atem-export">' +
            '<button class="atem-btn" id="atemExportJson">Sessions als JSON</button>' +
            '<button class="atem-btn" id="atemExportCsv">Sessions als CSV</button>' +
          '</div>' +
        '</div>';

      byId('atemWeeklyGoal').addEventListener('change', e => { saveSetting('weeklyGoal', Number(e.target.value)); render(); });
      byId('atemFilterTechnik').addEventListener('change', e => { filterTechnik = e.target.value; render(); });
      byId('atemFilterPlan').addEventListener('change', e => { filterPlan = e.target.value; render(); });
      byId('atemShowSim').addEventListener('change', e => { showSimulated = e.target.checked; render(); });
      byId('atemExportJson').addEventListener('click', () => {
        RT.downloadJSON({app:'radtraining-atmung', exportedAt:new Date().toISOString(), sessions:filteredSessions()}, 'atmung-sessions-' + today + '.json');
      });
      byId('atemExportCsv').addEventListener('click', () => {
        // Das BOM sorgt dafür, dass Excel die Umlaute richtig liest.
        const blob = new Blob(['﻿' + Core.sessionsToCsv(filteredSessions())], {type:'text/csv;charset=utf-8'});
        RT.downloadBlob(blob, 'atmung-sessions-' + today + '.csv');
      });
      drawCharts(list, records, today);
    }

    (async function load(){
      try{
        [sessions, rfResults, plans] = await Promise.all([loadSessions(), loadRfResults(), loadPlans()]);
      }catch(e){
        loadError = 'Daten konnten nicht geladen werden: ' + e.message;
      }
      render();
    })();

    return () => chartSet.destroy();
  }

  /* ---------- Morgen-HRV ---------- */
  async function loadMorning(){
    const stored = await RT.store.get(MORNING_KEY);
    return stored ? JSON.parse(stored.value) : [];
  }

  function renderMorningView(root, preset){
    const byId = id => document.getElementById(id);
    const chartSet = createChartSet();
    let runner = null;
    let detachSetup = null;

    async function showSetup(message){
      viewEl.classList.remove('atem-running');
      root.innerHTML =
        (preset ? '<div class="atem-card atem-preset"><h3 class="atem-card-title">' + RT.escapeHtml(preset.title) + '</h3></div>' : '') +
        (message ? '<p class="atem-hint" id="atemMorningMessage">' + RT.escapeHtml(message) + '</p>' : '') +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">So läuft die Messung</h3>' +
          '<p class="atem-hint">Morgens nach dem Aufwachen, liegend oder sitzend, immer möglichst gleich. Atme ganz normal, ohne Pacer. Die Messung dauert 2 min, die ersten 30 s werden verworfen.</p>' +
        '</div>' +
        connectionCardsHtml(true) +
        '<button class="atem-btn primary atem-start" id="atemMorningStart">Messung starten</button>' +
        '<p class="atem-hint" id="atemMorningStartHint"></p>' +
        '<div id="atemMorningResults"></div>';
      const updateConnection = bindConnectionCards();
      function updateSetup(){
        updateConnection();
        byId('atemMorningStart').disabled = !signalActive();
        byId('atemMorningStartHint').textContent = signalActive() ? '' : 'Die Messung braucht den Gurt: Verbinde ihn zuerst.';
      }
      byId('atemMorningStart').addEventListener('click', startRun);
      signal.listeners.add(updateSetup);
      detachSetup = () => signal.listeners.delete(updateSetup);
      updateSetup();
      try{
        renderResults(await loadMorning());
      }catch(e){
        const holder = byId('atemMorningResults');
        if(holder) holder.innerHTML = '<p class="atem-error" role="alert">Messungen konnten nicht geladen werden: ' + RT.escapeHtml(e.message) + '</p>';
      }
    }

    function renderResults(entries){
      const holder = byId('atemMorningResults');
      if(!holder) return;
      const series = Core.morningSeries(entries);
      const hiddenCount = entries.length - entries.filter(e => e.source !== 'sim' && e.quality !== 'schlecht').length;
      const latest = series[series.length - 1];
      holder.innerHTML =
        '<div class="atem-card" id="atemMorningLatest"><h3 class="atem-card-title">Dein Verlauf</h3>' +
          (latest
            ? '<div class="atem-stats atem-stats-two">' +
                '<div class="field"><div class="v atem-stat-value">' + fmt(latest.ln, 2) + '</div><div class="l">lnRMSSD ' + fmtShortDate(latest.date) + '</div></div>' +
                '<div class="field"><div class="v atem-stat-value">' + fmt(latest.mean7, 2) + '</div><div class="l">7-Tage-Mittel</div></div>' +
              '</div>' +
              (Core.morningBelowBand(series, todayIso()) ? '<p class="atem-hint" id="atemMorningBelow">Dein 7-Tage-Mittel liegt unter deinem Normalband.</p>' : '') +
              (latest.bandLow === null ? '<p class="atem-hint">Das Normalband erscheint ab 7 Messungen, das 7-Tage-Mittel ab 3.</p>' : '')
            : '<p class="atem-hint">Noch keine Messung.</p>') +
          (hiddenCount ? '<p class="atem-hint">' + hiddenCount + ' ' + (hiddenCount === 1 ? 'Messung zählt' : 'Messungen zählen') + ' nicht mit (Simulator oder gestörtes Signal).</p>' : '') +
        '</div>' +
        chartHtml('atemChartMorning', 'lnRMSSD morgens') +
        '<p class="atem-hint">Schattiert ist dein Normalband: Mittelwert ± 0,5 Standardabweichungen der letzten 30 Tage.</p>';
      const labels = series.map(p => fmtShortDate(p.date));
      const band = cssToken('--line');
      chartSet.destroy();
      chartSet.draw('atemChartMorning', labels, [
        {label:'_oben', data:series.map(p => p.bandHigh), borderWidth:0, pointRadius:0, pointHitRadius:0, fill:'+1', backgroundColor:band, spanGaps:true},
        {label:'_unten', data:series.map(p => p.bandLow), borderWidth:0, pointRadius:0, pointHitRadius:0, spanGaps:true},
        lineDataset('Tageswert', series.map(p => p.ln), cssToken('--ink-soft'), {borderWidth:0, showLine:false}),
        lineDataset('7-Tage-Mittel', series.map(p => p.mean7), CHART_BLUE, {pointRadius:0})
      ], {yTitle:'lnRMSSD'});
    }

    function startRun(){
      detachSetup();
      detachSetup = null;
      chartSet.destroy();
      signal.resetRecording();
      const source = signal.source;
      const startedAt = new Date();
      const steps = [
        {label:'Einschwingen', kind:'rest', durationMs:Core.MORNING_SETTLE_MS, nextLabel:'Überspringen', restLabel:'Normal atmen'},
        {label:'Messung', kind:'rest', durationMs:Core.MORNING_MEASURE_MS, nextLabel:'Beenden', restLabel:'Normal atmen'}
      ];
      runner = createStepRunner({
        root, steps, measuring:true,
        onFinish: ({ranges}) => {
          runner = null;
          finishRun(ranges[1], source, startedAt);
        }
      });
    }

    async function finishRun(range, source, startedAt){
      const beats = range ? Core.beatsBetween(signal.pipeline.beats, range.start, range.end) : [];
      const stats = range ? Core.segmentStats(signal.pipeline.beats, range) : null;
      if(!stats || stats.beats < Core.MORNING_MIN_BEATS || stats.lnRmssd === null){
        showSetup('Zu wenige saubere Schläge, die Messung wurde nicht gespeichert.');
        return;
      }
      const artefacts = Core.artefactStats(beats);
      const entry = {
        id: RT.uid(),
        startedAt: startedAt.toISOString(),
        date: RT.toISODate(startedAt),
        time: String(startedAt.getHours()).padStart(2, '0') + ':' + String(startedAt.getMinutes()).padStart(2, '0'),
        technik: 'morgen-hrv',
        planId: preset && preset.planId || null,
        unitId: preset && preset.unitId || null,
        rmssd: round2(stats.rmssd),
        lnRmssd: round2(stats.lnRmssd),
        hr: round2(stats.hr),
        beats: stats.beats,
        artefactRate: artefacts.rate === null ? null : Math.round(artefacts.rate * 10000) / 10000,
        quality: artefacts.quality,
        source
      };
      try{
        const entries = await loadMorning();
        entries.push(entry);
        await RT.store.set(MORNING_KEY, JSON.stringify(entries));
      }catch(e){
        root.innerHTML = '<p class="atem-error" role="alert">Speichern fehlgeschlagen: ' + RT.escapeHtml(e.message) + '. Sichere die Messung als Datei.</p>' +
          '<div class="atem-actions"><button class="atem-btn" id="atemMorningExport">Als JSON sichern</button></div>';
        byId('atemMorningExport').addEventListener('click', () => RT.downloadJSON(entry, 'atmung-morgen-hrv-' + todayIso() + '.json'));
        return;
      }
      const poor = entry.quality !== 'gut';
      showSetup('Gespeichert: lnRMSSD ' + fmt(entry.lnRmssd, 2) + ', RMSSD ' + fmt(entry.rmssd, 1) + ' ms.' +
        (entry.quality === 'schlecht' ? ' Das Signal war gestört, deshalb zählt die Messung nicht für den Verlauf.' : '') +
        (poor ? ' Befeuchte die Elektroden und zieh den Gurt etwas fester.' : ''));
    }

    showSetup();
    return {
      cleanup(){
        if(detachSetup) detachSetup();
        if(runner) runner.stop();
        runner = null;
        chartSet.destroy();
      },
      beforeLeave(){
        return runner ? confirm('Messung abbrechen? Sie wird nicht gespeichert.') : true;
      }
    };
  }

  /* ---------- Wissen ---------- */
  const KNOWLEDGE = [
    ['Was passiert beim langsamen Atmen?',
      'Bei langsamer Atmung schwingen Herzfrequenz und Atmung gemeinsam (respiratorische Sinusarrhythmie), der Baroreflex wird angeregt. Eine Metaanalyse über 223 Studien fand einen Anstieg der vagal vermittelten HRV während der Übung, direkt danach und nach mehrwöchigem Training (Laborde et al. 2022, NBR; Shaffer & Meehan 2020).'],
    ['Was bringt HRV-Biofeedback?',
      'Über viele Anwendungen hinweg zeigte sich ein kleiner bis mittlerer Effekt, am größten bei Angst, Depressivität, Ärger sowie sportlicher und künstlerischer Leistung; je Anwendung gibt es aber nur wenige Studien (Lehrer et al. 2020). Bei selbstberichtetem Stress und selbstberichteter Angst war der Rückgang groß (Goessl et al. 2017).'],
    ['Resonanzfrequenz',
      'Die individuelle Resonanzfrequenz liegt bei Erwachsenen meist zwischen 4,5 und 6,5 Atemzügen/min. Fachleute bewerten sie anhand mehrerer Kriterien und erweitern den Test, wenn das Maximum am Rand bei 4,5 oder 6,5 liegt (Shaffer & Meehan 2020). Der Test in dieser App nutzt nur die RSA-Amplitude und ist deshalb eine Vereinfachung. Fällt dir eine sehr langsame Frequenz schwer, kann das zum Überatmen führen: Dann atme schneller.'],
    ['Mit oder ohne Biofeedback?',
      'In einer Studie mit 112 Teilnehmenden stieg die RMSSD bei 6 Atemzügen/min mit und ohne Biofeedback-Anzeige; die Stimmung war mit Anzeige insgesamt etwas positiver (Laborde et al. 2022, Psychophysiology). Du kannst die Anzeige also frei wählen.'],
    ['Akut und im Training',
      'Tägliche 5 min zyklisches Seufzen verbesserten in einer randomisierten Studie über einen Monat die Stimmung stärker als Achtsamkeitsmeditation (Balban et al. 2023). Wettkampfsituationen hat die Studie nicht untersucht. Veränderungen der Ruhe-HRV fanden sich nach mehrwöchigem Training (Laborde et al. 2022, NBR).'],
    ['Warum die App auf Gewohnheit statt Serien setzt',
      'Gewohnheiten brauchten im Median rund 66 Tage bis zur Automatisierung, mit einer Spanne von 18 bis 254 Tagen, und ein einzelner ausgelassener Tag störte kaum (Lally et al. 2010). Wenn-Dann-Pläne helfen, Ziele umzusetzen (Gollwitzer & Sheeran 2006). Punkte und Abzeichen sind in Gesundheits-Apps verbreitet, ohne dass ihre Anzahl mit besseren Bewertungen zusammenhing (Edwards et al. 2016). Die App lässt sie deshalb weg.'],
    ['Messgrenzen',
      'Brustgurt-Daten sind gut, aber kein Medizinprodukt, und eine einzelne Messung sagt wenig. Bei langsamer Atmung liegt die Atmung im LF-Band, LF/HF ist dann nicht als Stressindex interpretierbar und wird nicht angezeigt. Trockene Elektroden können Fehlschläge vortäuschen. Bei Herzstolpern, Schwindel oder bekannten Herzrhythmusstörungen lass es ärztlich abklären.']
  ];
  const SOURCES = [
    ['Laborde S. et al. (2022). Effects of voluntary slow breathing on heart rate and heart rate variability: A systematic review and a meta-analysis. Neurosci Biobehav Rev 138:104711.', '10.1016/j.neubiorev.2022.104711'],
    ['Laborde S. et al. (2022). Psychophysiological effects of slow-paced breathing at six cycles per minute with or without heart rate variability biofeedback. Psychophysiology 59:e13952.', '10.1111/psyp.13952'],
    ['Lehrer P. et al. (2020). Heart Rate Variability Biofeedback Improves Emotional and Physical Health and Performance: A Systematic Review and Meta Analysis. Appl Psychophysiol Biofeedback 45(3):109–129.', '10.1007/s10484-020-09466-z'],
    ['Goessl V.C., Curtiss J.E., Hofmann S.G. (2017). The effect of heart rate variability biofeedback training on stress and anxiety: a meta-analysis. Psychol Med 47(15):2578–2586.', '10.1017/S0033291717001003'],
    ['Shaffer F., Meehan Z.M. (2020). A Practical Guide to Resonance Frequency Assessment for Heart Rate Variability Biofeedback. Front Neurosci 14:570400.', '10.3389/fnins.2020.570400'],
    ['Balban M.Y. et al. (2023). Brief structured respiration practices enhance mood and reduce physiological arousal. Cell Rep Med 4(1):100895.', '10.1016/j.xcrm.2022.100895'],
    ['Lally P. et al. (2010). How are habits formed: Modelling habit formation in the real world. Eur J Soc Psychol 40(6):998–1009.', '10.1002/ejsp.674'],
    ['Edwards E.A. et al. (2016). Gamification for health promotion: systematic review of behaviour change techniques in smartphone apps. BMJ Open 6:e012447.', '10.1136/bmjopen-2016-012447'],
    ['Gollwitzer P.M., Sheeran P. (2006). Implementation intentions and goal achievement: A meta-analysis. Adv Exp Soc Psychol 38:69–119.', '10.1016/S0065-2601(06)38002-1']
  ];

  function renderKnowledgeView(root){
    root.innerHTML =
      KNOWLEDGE.map(item => '<div class="atem-card"><h3 class="atem-card-title atem-knowledge-title">' + RT.escapeHtml(item[0]) + '</h3><p class="atem-text">' + RT.escapeHtml(item[1]) + '</p></div>').join('') +
      '<div class="atem-card"><h3 class="atem-card-title">Quellen</h3><ul class="atem-sources" id="atemSources">' +
        SOURCES.map(source => '<li>' + RT.escapeHtml(source[0]) + ' <a href="https://doi.org/' + source[1] + '" target="_blank" rel="noopener noreferrer">doi:' + source[1] + '</a></li>').join('') +
      '</ul></div>';
  }

  /* ---------- Startseite: heutige Einheit und Morgen-HRV-Hinweis ---------- */
  async function renderHome(){
    const todayEl = document.getElementById('atemToday');
    const hintEl = document.getElementById('atemHrvHint');
    if(!todayEl || !hintEl) return;
    try{
      const [active, plans, records, latest, morning] = await Promise.all([
        loadActivePlan(),
        RT.store.get(PLANS_KEY).then(stored => stored ? JSON.parse(stored.value) : []),
        loadPlanRecords(),
        latestRealRf(),
        loadMorning()
      ]);
      const today = todayIso();
      const plan = active ? plans.find(p => p.id === active.planId) : null;
      const open = plan ? Core.unitsForDay(plan, active.startDate, today, records).filter(item => !item.done) : [];
      const rfBpm = latest ? latest.recommendedBpm : null;
      if(open.length){
        todayEl.innerHTML = '<div class="atem-home"><div class="atem-home-title">Heute offen · ' + RT.escapeHtml(plan.name) + '</div>' +
          (active.trigger ? '<div class="atem-muted" id="atemHomeTrigger">' + RT.escapeHtml(triggerSentence(active.trigger)) + '</div>' : '') +
          open.map(item => '<div class="atem-home-unit"><span>' + RT.escapeHtml(unitLabel(item.unit, rfBpm)) + '</span>' +
            '<button class="atem-btn primary" data-home-unit="' + item.unit.id + '">Start</button></div>').join('') +
          '</div>';
        todayEl.querySelectorAll('[data-home-unit]').forEach(button => {
          button.addEventListener('click', () => launchPlanUnit(plan, active.startDate, button.dataset.homeUnit, rfBpm));
        });
      } else {
        todayEl.innerHTML = '';
      }
      const below = Core.morningBelowBand(Core.morningSeries(morning), today);
      hintEl.innerHTML = below
        ? '<div class="atem-home atem-home-hint" role="status">Dein 7-Tage-Mittel der Morgen-HRV liegt unter deinem Normalband. Das ist nur ein Hinweis, dein Plan ändert sich dadurch nicht.</div>'
        : '';
    }catch(e){
      console.error('Atmung: Startseite nicht aktualisiert', e);
    }
  }

  /* ---------- Unterseiten ---------- */
  const VIEWS = {
    session: {title:'Session starten', render:renderSessionView},
    rf: {title:'Resonanzfrequenz-Test', render:renderRfView},
    plaene: {title:'Trainingspläne', render:renderPlansView},
    morgen: {title:'Morgen-HRV', render:renderMorningView},
    verlauf: {title:'Verlauf', render:renderHistoryView},
    wissen: {title:'Wissen', render:renderKnowledgeView},
    signal: {title:'Gurt & Signal', render:renderSignalView}
  };
  const HASH_PREFIX = '#atem/';

  const viewEl = document.createElement('div');
  viewEl.className = 'atem-view';
  viewEl.id = 'atemView';
  viewEl.hidden = true;
  viewEl.innerHTML =
    '<div class="atem-view-inner">' +
      '<header class="atem-view-head">' +
        '<button class="atem-btn" id="atemBack" aria-label="Zurück zur Trainingsübersicht">← Zurück</button>' +
        '<h2 class="atem-view-title" id="atemViewTitle"></h2>' +
      '</header>' +
      '<div id="atemViewBody"></div>' +
    '</div>';
  document.body.appendChild(viewEl);

  let activeView = null;   // {name, cleanup, beforeLeave}
  let pendingPreset = null;

  function viewNameFromHash(){
    if(location.hash.indexOf(HASH_PREFIX) !== 0) return null;
    const name = location.hash.slice(HASH_PREFIX.length);
    return VIEWS[name] ? name : null;
  }

  function syncViewWithHash(){
    const name = viewNameFromHash();
    if(activeView && activeView.name === name) return;
    if(activeView){
      if(activeView.beforeLeave && !activeView.beforeLeave()){
        // Zurück-Geste abgelehnt: Der Verlaufseintrag ist schon weg, also neu anlegen.
        pushViewEntry(activeView.name);
        return;
      }
      if(activeView.cleanup) activeView.cleanup();
      const opener = navEl.querySelector('[data-atem-view="' + activeView.name + '"]');
      activeView = null;
      if(opener && !name) opener.focus();
    }
    viewEl.hidden = !name;
    document.body.classList.toggle('atem-open', !!name);
    if(!name){
      renderHome();
      return;
    }
    document.getElementById('atemViewTitle').textContent = VIEWS[name].title;
    const body = document.getElementById('atemViewBody');
    const preset = pendingPreset;
    pendingPreset = null;
    const rendered = VIEWS[name].render(body, preset);
    activeView = typeof rendered === 'function'
      ? {name, cleanup:rendered, beforeLeave:null}
      : {name, cleanup:rendered ? rendered.cleanup : null, beforeLeave:rendered ? rendered.beforeLeave : null};
    viewEl.scrollTop = 0;
    document.getElementById('atemBack').focus();
  }

  /* atemDepth zählt eigene Verlaufseinträge. Fehlt er, wurde die Seite direkt mit #atem/... geöffnet. */
  function pushViewEntry(name){
    const depth = (history.state && history.state.atemDepth || 0) + 1;
    history.pushState({atemDepth:depth}, '', HASH_PREFIX + name);
  }

  function openView(name){
    pushViewEntry(name);
    syncViewWithHash();
  }

  /* Öffnet eine Unterseite aus einer anderen heraus, optional mit Vorbelegung. */
  function launchView(name, preset){
    pendingPreset = preset || null;
    openView(name);
  }

  function closeView(){
    if(activeView && activeView.beforeLeave){
      if(!activeView.beforeLeave()) return;
      activeView.beforeLeave = null;  // nicht ein zweites Mal beim Verlassen fragen
    }
    if(history.state && history.state.atemDepth){
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      syncViewWithHash();
    }
  }

  document.getElementById('atemBack').addEventListener('click', closeView);
  window.addEventListener('popstate', syncViewWithHash);
  navEl.querySelectorAll('[data-atem-view]').forEach(button => {
    button.addEventListener('click', () => openView(button.dataset.atemView));
  });

  /* ---------- Start ---------- */
  (async function init(){
    await loadSettings();
    navEl.open = !!settings.navOpen;
    navEl.addEventListener('toggle', () => {
      if(settings.navOpen === navEl.open) return;
      settings.navOpen = navEl.open;
      saveSettings();
    });
    renderMenuStatus();
    syncViewWithHash();
    renderHome();
  })();
})();
