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
    keepRr: false
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

    setBreathHz(hz){ if(this.generator) this.generator.setBreathHz(hz); },

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
        '<p class="atem-hint">Der Sigma-Gurt erlaubt nur eine BLE-Verbindung. Trenne vorher die Sigma-App und den Radcomputer.</p>' +
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
      if(kind === 'in'){ this.tone(440, 0.35, 0.05); this.vibrate(60); }
      else { this.tone(330, 0.35, 0.05); this.vibrate([40, 80, 40]); }
    },
    step(){
      this.tone(523, 0.6, 0.06);
      this.vibrate(250);
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

  /* ---------- Session ---------- */
  function renderSessionView(root){
    const byId = id => document.getElementById(id);
    let run = null;
    let pending = null;   // abgeschlossene, noch nicht gespeicherte Session
    let tensionBefore = null;
    let frameHandle = null;
    let tickTimer = null;
    let detachSetup = null;

    function applyEvening(){ viewEl.classList.toggle('atem-evening', eveningActive()); }
    function saveSetting(key, value){ settings[key] = value; saveSettings(); }

    function scaleHtml(id, label){
      let chips = '';
      for(let value = 0; value <= 10; value++){
        chips += '<button type="button" class="atem-chip" data-value="' + value + '" aria-pressed="false">' + value + '</button>';
      }
      return '<div class="atem-scale" id="' + id + '" role="group" aria-label="' + label + '">' + chips + '</div>';
    }
    function bindScale(id, onChange){
      const group = byId(id);
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

    /* ----- Vorbereitung ----- */
    function showSetup(){
      viewEl.classList.remove('atem-running');
      applyEvening();
      tensionBefore = null;
      root.innerHTML =
        connectionCardsHtml(true) +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Atemmuster</h3>' +
          '<div class="atem-fields">' +
            '<label class="atem-field"><span>Atemzüge/min</span><select class="atem-select" id="atemBpm">' +
              optionsHtml(Core.BPM_OPTIONS.map(bpm => ({value:bpm, label:fmtBpm(bpm)})), settings.bpm) + '</select></label>' +
            '<label class="atem-field"><span>Ein : Aus</span><select class="atem-select" id="atemIe">' +
              optionsHtml(Object.keys(Core.IE_OPTIONS).map(ie => ({value:ie, label:ie})), settings.ie) + '</select></label>' +
            '<label class="atem-field"><span>Dauer</span><select class="atem-select" id="atemDuration">' +
              optionsHtml(SESSION_MINUTES.map(min => ({value:min, label:min + ' min'})), settings.durationMin) + '</select></label>' +
          '</div>' +
          '<p class="atem-hint" id="atemPatternHint"></p>' +
        '</div>' +
        foldableCard('Anzeige und Hinweise', true,
          '<div class="atem-checks">' +
            checkHtml('atemTone', 'Leiser Ton am Phasenwechsel', settings.tone) +
            checkHtml('atemVibrate', 'Vibration am Phasenwechsel', settings.vibrate) +
            checkHtml('atemFeedback', 'Live-Feedback anzeigen', settings.showFeedback) +
            checkHtml('atemKeepRr', 'RR-Rohdaten speichern (rund 8 KB je 20 min)', settings.keepRr) +
          '</div>' +
          '<label class="atem-field atem-field-wide"><span>Abendmodus</span><select class="atem-select" id="atemEvening">' +
            optionsHtml([{value:'auto', label:'Automatisch ab 19 Uhr'}, {value:'an', label:'An'}, {value:'aus', label:'Aus'}], settings.eveningMode) +
          '</select></label>') +
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
      function updatePatternHint(){
        const pattern = Core.buildBreathPattern(settings.bpm, settings.ie);
        byId('atemPatternHint').textContent = fmt(pattern.phases[0].ms / 1000, 1) + ' s ein, ' + fmt(pattern.phases[1].ms / 1000, 1) + ' s aus';
      }
      byId('atemBpm').addEventListener('change', e => { saveSetting('bpm', Number(e.target.value)); updatePatternHint(); });
      byId('atemIe').addEventListener('change', e => { saveSetting('ie', e.target.value); updatePatternHint(); });
      byId('atemDuration').addEventListener('change', e => saveSetting('durationMin', Number(e.target.value)));
      byId('atemTone').addEventListener('change', e => { saveSetting('tone', e.target.checked); if(e.target.checked) cues.phase('in'); });
      byId('atemVibrate').addEventListener('change', e => { saveSetting('vibrate', e.target.checked); if(e.target.checked) cues.phase('in'); });
      byId('atemFeedback').addEventListener('change', e => saveSetting('showFeedback', e.target.checked));
      byId('atemKeepRr').addEventListener('change', e => saveSetting('keepRr', e.target.checked));
      byId('atemEvening').addEventListener('change', e => { saveSetting('eveningMode', e.target.value); applyEvening(); });
      bindScale('atemTensionBefore', value => { tensionBefore = value; });
      byId('atemStart').addEventListener('click', startRun);
      signal.listeners.add(updateSetup);
      detachSetup = () => signal.listeners.delete(updateSetup);
      updateSetup();
      updatePatternHint();
    }

    /* ----- Ablauf ----- */
    function startRun(){
      detachSetup();
      detachSetup = null;
      cues.prepare();
      const measuring = signalActive();
      if(measuring) signal.resetRecording();
      run = {
        pattern: Core.buildBreathPattern(settings.bpm, settings.ie),
        plannedMs: settings.durationMin * 60000,
        measuring,
        source: measuring ? signal.source : null,
        tensionBefore,
        startedAt: new Date(),
        ranges: {baseline:null, pacer:null, post:null},
        step: null,
        stepStart: 0,
        lastPhaseKey: null,
        hiddenMs: 0,
        hiddenSince: document.visibilityState === 'hidden' ? performance.now() : null,
        tickCount: 0
      };
      renderRunScreen();
      wakeLock.onChange = updateRunHints;
      wakeLock.acquire();
      signal.listeners.add(updateRunHints);
      document.addEventListener('visibilitychange', trackVisibility);
      enterStep(measuring ? 'baseline' : 'pacer');
      tickTimer = setInterval(tick, 100);
      frameHandle = requestAnimationFrame(frame);
    }

    function trackVisibility(){
      if(!run) return;
      const now = performance.now();
      if(document.visibilityState === 'hidden') run.hiddenSince = now;
      else if(run.hiddenSince !== null){
        run.hiddenMs += now - run.hiddenSince;
        run.hiddenSince = null;
      }
      updateRunHints();
    }

    function stepDuration(step){ return step === 'pacer' ? run.plannedMs : REST_MEASUREMENT_MS; }

    function enterStep(step){
      const now = performance.now();
      if(run.step) run.ranges[run.step] = {start:run.stepStart, end:now};
      if(!step){ finishRun(); return; }
      if(run.step) cues.step();
      run.step = step;
      run.stepStart = now;
      run.lastPhaseKey = null;
      sim.setBreathHz(step === 'pacer' ? run.pattern.bpm / 60 : 0.25);
      byId('atemRunStep').textContent = STEP_LABELS[step];
      byId('atemRunNext').textContent = step === 'pacer' ? 'Beenden' : 'Überspringen';
      if(step !== 'pacer'){
        byId('atemPacerLabel').textContent = 'Normal atmen';
        byId('atemPacerCircle').dataset.kind = 'rest';
      }
    }

    function nextStep(){
      if(run.step === 'baseline') enterStep('pacer');
      else if(run.step === 'pacer') enterStep(run.measuring ? 'post' : null);
      else enterStep(null);
    }

    function tick(){
      if(!run) return;
      const now = performance.now();
      const elapsed = now - run.stepStart;
      const duration = stepDuration(run.step);
      if(elapsed >= duration){ nextStep(); return; }
      byId('atemRunCountdown').textContent = fmtCountdown(duration - elapsed);
      if(run.step === 'pacer'){
        const state = Core.pacerState(run.pattern, elapsed);
        const key = state.cycleIndex + ':' + state.phaseIndex;
        if(key !== run.lastPhaseKey){
          run.lastPhaseKey = key;
          cues.phase(state.kind);
          byId('atemPacerLabel').textContent = state.label;
          byId('atemPacerCircle').dataset.kind = state.kind;
        }
      }
      run.tickCount++;
      if(run.measuring && settings.showFeedback){
        if(run.tickCount % 3 === 0) redrawCurve(now);
        if(run.tickCount % 10 === 0) updateRsa(now);
      }
    }

    /* Rein zeitbasiert: Nach einer Verzögerung springt der Kreis an die richtige Stelle. */
    function frame(){
      if(!run) return;
      const circle = byId('atemPacerCircle');
      const level = run.step === 'pacer'
        ? Core.pacerState(run.pattern, performance.now() - run.stepStart).level
        : 0.35;
      circle.style.transform = 'scale(' + (0.42 + 0.58 * level).toFixed(4) + ')';
      frameHandle = requestAnimationFrame(frame);
    }

    function redrawCurve(now){
      const bands = run.step === 'pacer' || run.ranges.pacer
        ? Core.pacerBands(run.pattern, run.ranges.pacer ? run.ranges.pacer.start : run.stepStart, now - CURVE_SPAN_MS,
            run.ranges.pacer ? run.ranges.pacer.end : now)
        : [];
      drawHeartRateCurve(byId('atemRunCurve'), signal.pipeline.beats, now, bands);
    }

    function updateRsa(now){
      const start = run.ranges.pacer ? run.ranges.pacer.start : (run.step === 'pacer' ? run.stepStart : null);
      if(start === null) return;
      const end = run.ranges.pacer ? run.ranges.pacer.end : now - RSA_EVALUATION_DELAY_MS;
      const cycles = Core.pacerCycles(run.pattern, start, end).slice(-RSA_TREND_CYCLES);
      const summary = Core.rsaSummary(signal.pipeline.beats.slice(-400), cycles);
      byId('atemRunRsa').textContent = summary.last === null ? '–' : fmt(summary.last, 1) + ' bpm';
      drawSparkline(byId('atemRunSpark'), summary.perCycle.filter(v => v !== null));
    }

    function updateFeedbackVisibility(){
      const visible = run.measuring && settings.showFeedback;
      byId('atemRunFeedback').hidden = !visible;
      byId('atemRunToggle').hidden = !run.measuring;
      byId('atemRunToggle').textContent = settings.showFeedback ? 'Feedback ausblenden' : 'Feedback einblenden';
    }

    function updateRunHints(){
      if(!run) return;
      const lost = run.measuring && signal.status === 'unterbrochen';
      byId('atemRunLost').hidden = !lost;
      byId('atemRunWake').hidden = !wakeLock.failed;
      byId('atemRunHidden').hidden = run.hiddenMs < 1000;
    }

    function renderRunScreen(){
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
            '<div class="atem-rsa-row"><div><div class="atem-rsa-value" id="atemRunRsa">–</div><div class="atem-rsa-label">RSA letzter Atemzyklus</div></div>' +
            '<canvas class="atem-spark" id="atemRunSpark"></canvas></div>' +
          '</div>' +
          '<div class="atem-actions atem-run-actions">' +
            '<button class="atem-btn" id="atemRunToggle"></button>' +
            '<button class="atem-btn" id="atemRunNext"></button>' +
          '</div>' +
        '</div>';
      byId('atemRunNext').addEventListener('click', nextStep);
      byId('atemRunReconnect').addEventListener('click', () => ble.open());
      byId('atemRunToggle').addEventListener('click', () => {
        saveSetting('showFeedback', !settings.showFeedback);
        updateFeedbackVisibility();
      });
      updateFeedbackVisibility();
      updateRunHints();
    }

    function stopRunMachinery(){
      clearInterval(tickTimer);
      cancelAnimationFrame(frameHandle);
      tickTimer = null;
      wakeLock.onChange = null;
      wakeLock.release();
      signal.listeners.delete(updateRunHints);
      document.removeEventListener('visibilitychange', trackVisibility);
    }

    function finishRun(){
      const finished = run;
      if(finished.hiddenSince !== null) finished.hiddenMs += performance.now() - finished.hiddenSince;
      stopRunMachinery();
      run = null;
      signal.pipeline.finish();
      const summary = Core.summarizeSession({
        beats: finished.measuring ? signal.pipeline.beats : [],
        pattern: finished.pattern,
        baseline: finished.ranges.baseline,
        pacer: finished.ranges.pacer,
        post: finished.ranges.post
      });
      pending = {finished, summary};
      showClosing();
    }

    /* ----- Abschluss ----- */
    function buildRecord(tensionAfter, note){
      const {finished, summary} = pending;
      const segment = stats => stats && {
        rmssd: round2(stats.rmssd), lnRmssd: round2(stats.lnRmssd), hr: round2(stats.hr), beats: stats.beats
      };
      const started = finished.startedAt;
      const pacerRange = finished.ranges.pacer;
      return {
        id: RT.uid(),
        startedAt: started.toISOString(),
        date: RT.toISODate(started),
        time: String(started.getHours()).padStart(2, '0') + ':' + String(started.getMinutes()).padStart(2, '0'),
        technik: 'spb',
        planId: null,
        unitId: null,
        bpm: finished.pattern.bpm,
        ie: finished.pattern.ie,
        plannedMin: finished.plannedMs / 60000,
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
        tensionBefore: finished.tensionBefore,
        tensionAfter,
        note,
        source: finished.source,
        hiddenSec: Math.round(finished.hiddenMs / 1000),
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
      viewEl.classList.remove('atem-running');
      viewEl.scrollTop = 0;
      const {finished, summary} = pending;
      const pacerRange = finished.ranges.pacer;
      const durationMs = pacerRange ? pacerRange.end - pacerRange.start : 0;
      let tensionAfter = null;
      const measured = finished.measuring && summary.beatCount > 0;
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
          (finished.source === 'sim' ? '<p class="atem-hint">Simulatordaten, keine echte Messung.</p>' : '') +
        '</div>' +
        '<div class="atem-card">' +
          '<h3 class="atem-card-title">Wie angespannt bist du jetzt?</h3>' +
          '<p class="atem-hint">0 = gar nicht, 10 = sehr stark. Optional.' +
            (finished.tensionBefore !== null ? ' Vorher: ' + finished.tensionBefore + '.' : '') + '</p>' +
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
      byId('atemSumPattern').textContent = fmtBpm(finished.pattern.bpm) + ' · ' + finished.pattern.ie;
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
        RT.downloadJSON(currentRecord(), 'atmung-session-' + RT.toISODate(new Date()) + '.json');
      });
      byId('atemDiscard').addEventListener('click', () => {
        if(!confirm('Session verwerfen? Sie wird nicht gespeichert.')) return;
        pending = null;
        showSetup();
      });
    }

    function showSaved(record){
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
        if(run) stopRunMachinery();
        run = null;
        viewEl.classList.remove('atem-running', 'atem-evening');
      },
      beforeLeave(){
        if(run) return confirm('Session abbrechen? Sie wird nicht gespeichert.');
        if(pending) return confirm('Session verwerfen? Sie ist noch nicht gespeichert.');
        return true;
      }
    };
  }

  /* ---------- Unterseiten ---------- */
  function renderPlannedView(text){
    return root => {
      root.innerHTML = '<div class="atem-card"><p class="atem-hint">' + RT.escapeHtml(text) + '</p></div>';
    };
  }
  const VIEWS = {
    session: {title:'Session starten', render:renderSessionView},
    rf: {title:'Resonanzfrequenz-Test', render:renderPlannedView('Folgt in Phase 3.')},
    plaene: {title:'Trainingspläne', render:renderPlannedView('Folgt in Phase 3.')},
    morgen: {title:'Morgen-HRV', render:renderPlannedView('Folgt in Phase 4.')},
    verlauf: {title:'Verlauf', render:renderPlannedView('Folgt in Phase 4.')},
    wissen: {title:'Wissen', render:renderPlannedView('Folgt in Phase 4.')},
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
  let pushedEntry = false; // false, wenn die Seite direkt mit #atem/... geladen wurde

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
        history.pushState(null, '', HASH_PREFIX + activeView.name);
        pushedEntry = true;
        return;
      }
      if(activeView.cleanup) activeView.cleanup();
      const opener = navEl.querySelector('[data-atem-view="' + activeView.name + '"]');
      activeView = null;
      if(opener && !name) opener.focus();
    }
    viewEl.hidden = !name;
    document.body.classList.toggle('atem-open', !!name);
    if(!name) return;
    document.getElementById('atemViewTitle').textContent = VIEWS[name].title;
    const body = document.getElementById('atemViewBody');
    const rendered = VIEWS[name].render(body);
    activeView = typeof rendered === 'function'
      ? {name, cleanup:rendered, beforeLeave:null}
      : {name, cleanup:rendered ? rendered.cleanup : null, beforeLeave:rendered ? rendered.beforeLeave : null};
    viewEl.scrollTop = 0;
    document.getElementById('atemBack').focus();
  }

  function openView(name){
    history.pushState(null, '', HASH_PREFIX + name);
    pushedEntry = true;
    syncViewWithHash();
  }

  function closeView(){
    if(activeView && activeView.beforeLeave){
      if(!activeView.beforeLeave()) return;
      activeView.beforeLeave = null;  // nicht ein zweites Mal beim Verlassen fragen
    }
    if(pushedEntry){
      pushedEntry = false;
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      syncViewWithHash();
    }
  }

  document.getElementById('atemBack').addEventListener('click', closeView);
  window.addEventListener('popstate', () => {
    pushedEntry = false;
    syncViewWithHash();
  });
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
  })();
})();
