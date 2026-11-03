/* Atmung & HRV: Menü, Unterseiten, Gurtverbindung und Signal-Ansicht.
   Signalverarbeitung: atmung-core.js. App-Helfer kommen über window.RT aus index.html. */
(function(){
  "use strict";

  const RT = window.RT, Core = window.AtemCore;
  const navEl = document.getElementById('atemNav');
  if(!RT || !Core || !navEl) return;

  const SETTINGS_KEY = 'atem:settings';
  const SIM_PROFILES = {
    normal: {label:'Normal (900 ± 60 ms)', meanRr:900, amplitude:60},
    stark: {label:'Starke RSA (1030 ± 170 ms)', meanRr:1030, amplitude:170}
  };
  const QUALITY_COLORS = {gut:'var(--good)', 'mäßig':'var(--gold)', schlecht:'var(--crimson)'};
  const DEBUG_RSA_WINDOW_MS = 10000;
  const CURVE_SPAN_MS = 60000;
  const NO_RR_WARNING_PACKETS = 10;

  function fmt(value, digits){
    return value === null || value === undefined ? '–' : value.toFixed(digits).replace('.', ',');
  }

  /* ---------- Einstellungen ---------- */
  let settings = {navOpen:false};
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
    pipeline: new Core.SignalPipeline(),
    listeners: new Set(),
    notify(){ this.listeners.forEach(fn => fn()); },
    setStatus(status){ this.status = status; this.notify(); },
    resetRecording(){
      this.pipeline = new Core.SignalPipeline();
      this.hr = null;
      this.lastPacketHex = null;
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
    const profileOptions = Object.keys(SIM_PROFILES)
      .map(key => '<option value="' + key + '">' + RT.escapeHtml(SIM_PROFILES[key].label) + '</option>').join('');
    root.innerHTML =
      '<div class="atem-card">' +
        '<div class="atem-status-line"><span class="atem-dot" id="atemConnDot"></span><strong id="atemConnState"></strong><span class="atem-muted" id="atemConnDetail"></span></div>' +
        '<p class="atem-hint">Der Sigma-Gurt erlaubt nur eine BLE-Verbindung. Trenne vorher die Sigma-App und den Radcomputer.</p>' +
        '<div class="atem-actions">' +
          '<button class="atem-btn primary" id="atemConnect">Gurt verbinden</button>' +
          '<button class="atem-btn" id="atemReconnect">Neu verbinden</button>' +
          '<button class="atem-btn" id="atemDisconnect">Trennen</button>' +
        '</div>' +
        '<p class="atem-error" id="atemError" role="alert"></p>' +
      '</div>' +
      '<div class="atem-card">' +
        '<h3 class="atem-card-title">Simulator</h3>' +
        '<div class="atem-actions">' +
          '<select class="atem-select" id="atemSimProfile" aria-label="Simulator-Profil">' + profileOptions + '</select>' +
          '<button class="atem-btn" id="atemSimToggle"></button>' +
        '</div>' +
      '</div>' +
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

    byId('atemConnect').addEventListener('click', () => ble.connect());
    byId('atemReconnect').addEventListener('click', () => ble.open());
    byId('atemDisconnect').addEventListener('click', () => {
      if(sim.running) sim.stop(); else ble.disconnect();
    });
    byId('atemSimToggle').addEventListener('click', () => {
      if(sim.running) sim.stop(); else sim.start(byId('atemSimProfile').value);
    });
    byId('atemReset').addEventListener('click', () => signal.resetRecording());
    byId('atemExport').addEventListener('click', () => {
      const {pipeline} = signal;
      RT.downloadJSON({
        exportedAt: new Date().toISOString(),
        source: signal.source,
        device: signal.deviceName,
        packets: pipeline.packets,
        packetsWithoutRr: pipeline.packetsWithoutRr,
        beats: pipeline.beats.map(b => ({t:Math.round(b.t), rr:Math.round(b.rr * 100) / 100, status:b.status, afterGap:b.afterGap}))
      }, 'atmung-signal-' + RT.toISODate(new Date()) + '.json');
    });

    function update(){
      const {pipeline} = signal;
      const stats = Core.artefactStats(pipeline.beats);
      const latest = pipeline.beats[pipeline.beats.length - 1];

      setText('atemConnState', STATUS_LABELS[signal.status]);
      byId('atemConnDot').style.background = STATUS_COLORS[signal.status];
      setText('atemConnDetail', [
        signal.deviceName,
        signal.battery !== null ? 'Akku ' + signal.battery + ' %' : null
      ].filter(Boolean).join(' · '));

      const busy = signal.status === 'verbinde';
      const active = signal.status === 'verbunden' || signal.status === 'simulator';
      byId('atemConnect').disabled = !ble.supported || busy;
      byId('atemReconnect').hidden = !(ble.device && signal.status === 'unterbrochen');
      byId('atemDisconnect').hidden = !active;
      byId('atemSimToggle').textContent = sim.running ? 'Simulator stoppen' : 'Simulator starten';
      byId('atemSimProfile').disabled = sim.running;

      let errorText = signal.error || '';
      if(!errorText && !ble.supported){
        errorText = 'Web Bluetooth ist hier nicht verfügbar. Nutze Chrome auf Android über https oder den Simulator.';
      }
      setText('atemError', errorText);
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

  function drawHeartRateCurve(canvas, beats, now){
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

    const css = getComputedStyle(document.documentElement);
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

  /* ---------- Unterseiten ---------- */
  function renderPlannedView(text){
    return root => {
      root.innerHTML = '<div class="atem-card"><p class="atem-hint">' + RT.escapeHtml(text) + '</p></div>';
    };
  }
  const VIEWS = {
    session: {title:'Session starten', render:renderPlannedView('Atempacer und Session-Ablauf folgen in Phase 2.')},
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

  let activeView = null;   // {name, cleanup}
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
    activeView = {name, cleanup: VIEWS[name].render(body) || null};
    viewEl.scrollTop = 0;
    document.getElementById('atemBack').focus();
  }

  function openView(name){
    history.pushState(null, '', HASH_PREFIX + name);
    pushedEntry = true;
    syncViewWithHash();
  }

  function closeView(){
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
