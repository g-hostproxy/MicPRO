import { AudioEngine, encodeWav } from './audio-engine.js';
import { FACTORY_PRESETS, DEFAULT_SETTINGS, normalize, clone } from './presets.js';

/* ------------------------------------------------------------------ */
/* platform bridge (falls back gracefully when run in a plain browser) */
/* ------------------------------------------------------------------ */
const bridge = window.micpro || {
  platform: 'web',
  version: async () => 'dev',
  setHotkeys: async () => ({}),
  onHotkey: () => () => {},
  setCloseToTray: async () => {},
  openExternal: async (u) => window.open(u, '_blank'),
  openPresetFile: async () => null,
  saveFile: async (data, name) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data]));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    return name;
  },
};
if (bridge.platform === 'darwin') document.body.classList.add('mac');

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

/* ------------------------------------------------------------------ */
/* persisted state                                                     */
/* ------------------------------------------------------------------ */
const store = {
  get(k, d) { try { const v = localStorage.getItem('micpro:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('micpro:' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const prefs = Object.assign(
  { inputId: 'default', outputId: null, monitorId: '', inputChannel: 'mix', monitorOn: false, monitorVolume: 0.8,
    hotkeys: { mute: 'CommandOrControl+Shift+M', bypass: 'CommandOrControl+Shift+B' }, tray: true, autostart: false, seenHelp: false },
  store.get('prefs', {}),
);
let userPresets = store.get('userPresets', []);
let activePresetId = store.get('activePreset', 'sm7b');
let modified = store.get('modified', false);
let settings = normalize(store.get('settings', null) || (allPresets().find((p) => p.id === activePresetId) || FACTORY_PRESETS[0]).settings);

const engine = new AudioEngine();
const savePrefs = () => store.set('prefs', prefs);
let saveTimer = 0;
function persistSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.set('settings', settings); store.set('activePreset', activePresetId); store.set('modified', modified); }, 250);
}

function allPresets() { return [...FACTORY_PRESETS, ...userPresets]; }

/* ------------------------------------------------------------------ */
/* toast                                                               */
/* ------------------------------------------------------------------ */
let toastTimer = 0;
function toast(msg, err = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
engine.on((ev) => {
  if (ev.type === 'error') toast(ev.message, true, 5000);
  if (ev.type === 'noise-learned') toast('Room noise learned. Denoise now targets it.');
  if (ev.type === 'state') renderTransport();
});

/* ------------------------------------------------------------------ */
/* knobs                                                               */
/* ------------------------------------------------------------------ */
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute"><defs>
  <radialGradient id="knobGrad" cx="40%" cy="32%" r="75%"><stop offset="0" stop-color="#55594a"/><stop offset=".55" stop-color="#2b2e24"/><stop offset="1" stop-color="#1a1c15"/></radialGradient>
</defs></svg>`);

const knobs = [];
const A0 = -135, A1 = 135;
const polar = (cx, cy, r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
const arcPath = (cx, cy, r, a, b) => {
  if (Math.abs(b - a) < 0.01) return '';
  const [x0, y0] = polar(cx, cy, r, a), [x1, y1] = polar(cx, cy, r, b);
  return `M${x0} ${y0} A${r} ${r} 0 ${Math.abs(b - a) > 180 ? 1 : 0} ${b > a ? 1 : 0} ${x1} ${y1}`;
};

function formatVal(v, unit, scale = 1) {
  const x = v * scale;
  if (unit === 'Hz') return x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(x)} Hz`;
  if (unit === ':1') return `${x.toFixed(1)}:1`;
  if (unit === '%') return `${Math.round(x)}%`;
  if (unit === 'dB+') return `${Math.round(x * 10) / 10} dB`;
  if (unit === 'dB') return `${x > 0 ? '+' : ''}${(Math.abs(x) < 10 && x % 1 ? x.toFixed(1) : Math.round(x * 10) / 10)} dB`;
  if (unit === 'ms') return `${x < 10 ? x.toFixed(1) : Math.round(x)} ms`;
  return `${x}`;
}

function makeKnob(el) {
  const k = {
    el, path: el.dataset.path, min: +el.dataset.min, max: +el.dataset.max, step: +el.dataset.step || 1,
    unit: el.dataset.unit || '', scale: +el.dataset.scale || 1, log: el.hasAttribute('data-log'),
  };
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', el.dataset.label);
  el.innerHTML = `<svg viewBox="0 0 58 58">
      <path class="track" d="${arcPath(29, 29, 25, A0, A1)}" fill="none" stroke-width="4" stroke-linecap="round"/>
      <path class="arc" fill="none" stroke-width="4" stroke-linecap="round"/>
      <circle class="cap" cx="29" cy="29" r="18" stroke-width="1"/>
      <line class="tick" x1="29" y1="29" x2="29" y2="14" stroke-width="2.4" stroke-linecap="round"/>
    </svg><span class="k-val"></span><span class="k-lbl">${el.dataset.label}</span>`;
  k.arc = $('.arc', el); k.tick = $('.tick', el); k.valEl = $('.k-val', el);

  const toNorm = (v) => k.log ? Math.log(v / k.min) / Math.log(k.max / k.min) : (v - k.min) / (k.max - k.min);
  const fromNorm = (n) => { n = Math.min(1, Math.max(0, n)); const v = k.log ? k.min * Math.pow(k.max / k.min, n) : k.min + n * (k.max - k.min); return Math.round(v / k.step) * k.step; };
  k.render = () => {
    const v = getPath(settings, k.path);
    const n = toNorm(v), ang = A0 + n * (A1 - A0);
    // bipolar knobs (range crosses zero) draw their arc from the centre
    const zeroAng = k.min < 0 && k.max > 0 && !k.log ? A0 + toNorm(0) * (A1 - A0) : A0;
    k.arc.setAttribute('d', arcPath(29, 29, 25, Math.min(zeroAng, ang), Math.max(zeroAng, ang)));
    k.tick.setAttribute('transform', `rotate(${ang} 29 29)`);
    k.valEl.textContent = formatVal(v, k.unit, k.scale);
    el.setAttribute('aria-valuenow', v);
    el.setAttribute('aria-valuetext', k.valEl.textContent);
  };
  const commit = (v) => { v = Math.min(k.max, Math.max(k.min, +v.toFixed(4))); setPath(settings, k.path, v); onSettingsChanged(); };

  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); el.focus();
    drag = { y: e.clientY, n: toNorm(getPath(settings, k.path)) };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const sens = e.shiftKey ? 900 : 180;
    commit(fromNorm(drag.n + (drag.y - e.clientY) / sens));
  });
  el.addEventListener('pointerup', () => { drag = null; });
  el.addEventListener('wheel', (e) => { e.preventDefault(); commit(fromNorm(toNorm(getPath(settings, k.path)) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.025))); }, { passive: false });
  el.addEventListener('dblclick', () => {
    const preset = allPresets().find((p) => p.id === activePresetId);
    commit(getPath(preset ? normalize(preset.settings) : DEFAULT_SETTINGS, k.path));
  });
  el.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 5, PageDown: -5 }[e.key];
    if (!d) return;
    e.preventDefault();
    commit(fromNorm(toNorm(getPath(settings, k.path)) + d * (e.shiftKey ? 0.004 : 0.02)));
  });
  knobs.push(k);
}
$$('.knob').forEach(makeKnob);

$$('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  setPath(settings, b.dataset.toggle, !getPath(settings, b.dataset.toggle)); onSettingsChanged();
}));
$$('[data-check]').forEach((c) => c.addEventListener('change', () => { setPath(settings, c.dataset.check, c.checked); onSettingsChanged(); }));

function renderControls() {
  knobs.forEach((k) => k.render());
  $$('[data-toggle]').forEach((b) => {
    const on = !!getPath(settings, b.dataset.toggle);
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    const unit = b.closest('.unit');
    if (unit && !['input', 'output'].includes(unit.dataset.unit)) unit.classList.toggle('off', !on);
  });
  $$('[data-check]').forEach((c) => { c.checked = !!getPath(settings, c.dataset.check); });
  drawEq();
}

function onSettingsChanged({ fromPreset = false } = {}) {
  if (!fromPreset) modified = true;
  engine.apply(settings);
  renderControls();
  renderPresets();
  persistSettings();
}

/* ------------------------------------------------------------------ */
/* presets                                                             */
/* ------------------------------------------------------------------ */
function loadPreset(id) {
  const p = allPresets().find((x) => x.id === id);
  if (!p) return;
  activePresetId = id; modified = false;
  settings = normalize(p.settings);
  onSettingsChanged({ fromPreset: true });
}

function renderPresets() {
  const list = $('#preset-list');
  const active = allPresets().find((p) => p.id === activePresetId);
  list.innerHTML = '';
  for (const p of allPresets()) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.className = p.id === activePresetId ? 'on' : '';
    b.innerHTML = `<span class="p-name"></span><span class="p-tag"></span>`;
    $('.p-name', b).textContent = p.name;
    $('.p-tag', b).textContent = p.id === activePresetId && modified ? 'Edited' : p.tag || 'Your preset';
    if (p.id === activePresetId && modified) $('.p-tag', b).classList.add('p-mod');
    if (p.user) {
      const del = document.createElement('span');
      del.className = 'p-del'; del.textContent = 'Delete'; del.setAttribute('role', 'button');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        userPresets = userPresets.filter((u) => u.id !== p.id); store.set('userPresets', userPresets);
        if (activePresetId === p.id) loadPreset('streamer'); else renderPresets();
        toast(`Deleted "${p.name}"`);
      });
      b.appendChild(del);
    }
    b.addEventListener('click', () => loadPreset(p.id));
    li.appendChild(b); list.appendChild(li);
  }
  let blurb = $('.preset-blurb');
  if (!blurb) { blurb = document.createElement('p'); blurb.className = 'preset-blurb'; list.after(blurb); }
  blurb.textContent = active?.blurb || '';
  blurb.hidden = !active?.blurb;
  $('#chip-preset').textContent = (active?.name || 'Custom') + (modified ? ' (edited)' : '');
}

$('#btn-save-preset').addEventListener('click', () => {
  const dlg = $('#dlg-name');
  const cur = allPresets().find((p) => p.id === activePresetId);
  $('#preset-name').value = cur?.user ? cur.name : `${cur?.name || 'My'} – custom`;
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const name = $('#preset-name').value.trim(); if (!name) return;
    const existing = userPresets.find((u) => u.name === name);
    if (existing) { existing.settings = clone(settings); activePresetId = existing.id; }
    else { const id = 'u' + Date.now().toString(36); userPresets.push({ id, name, tag: 'Your preset', user: true, settings: clone(settings) }); activePresetId = id; }
    store.set('userPresets', userPresets); modified = false; persistSettings(); renderPresets();
    toast(`Saved "${name}"`);
  };
});
$('#btn-export').addEventListener('click', async () => {
  const cur = allPresets().find((p) => p.id === activePresetId);
  const name = cur?.name || 'MicPRO preset';
  const data = new TextEncoder().encode(JSON.stringify({ micpro: 1, name, settings }, null, 2));
  const saved = await bridge.saveFile(data, `${name.replace(/[^\w\- ]+/g, '')}.micpro`, [{ name: 'MicPRO preset', extensions: ['micpro'] }]);
  if (saved) toast('Preset exported');
});
$('#btn-import').addEventListener('click', async () => {
  let text = await bridge.openPresetFile();
  if (!text && bridge.platform === 'web') {
    text = await new Promise((res) => { const i = document.createElement('input'); i.type = 'file'; i.accept = '.micpro,.json'; i.onchange = () => i.files[0]?.text().then(res); i.click(); });
  }
  if (!text) return;
  try {
    const obj = JSON.parse(text);
    if (!obj.settings) throw new Error('missing settings');
    const id = 'u' + Date.now().toString(36);
    userPresets.push({ id, name: String(obj.name || 'Imported').slice(0, 40), tag: 'Imported', user: true, settings: normalize(obj.settings) });
    store.set('userPresets', userPresets); loadPreset(id); toast('Preset imported');
  } catch {
    toast('That file isn\'t a MicPRO preset.', true);
  }
});

/* ------------------------------------------------------------------ */
/* devices                                                             */
/* ------------------------------------------------------------------ */
const isVirtual = (label) => /cable input|vb-audio|voicemeeter|virtual|blackhole|loopback/i.test(label);

async function refreshDevices() {
  let { inputs, outputs } = await AudioEngine.listDevices();
  const fill = (sel, devs, extra, current) => {
    sel.innerHTML = '';
    for (const [v, t] of extra) sel.add(new Option(t, v));
    devs.forEach((d, i) => sel.add(new Option(d.label || `Device ${i + 1}`, d.deviceId)));
    sel.value = [...sel.options].some((o) => o.value === current) ? current : sel.options[0]?.value ?? '';
  };
  if (prefs.outputId == null) {
    const cable = outputs.find((d) => /cable input/i.test(d.label)) || outputs.find((d) => isVirtual(d.label));
    prefs.outputId = cable ? cable.deviceId : '';
  }
  fill($('#sel-input'), inputs.filter((d) => d.deviceId !== 'communications'), [], prefs.inputId);
  fill($('#sel-output'), outputs.filter((d) => d.deviceId !== 'communications'), [['', 'Nowhere (preview only)']], prefs.outputId);
  fill($('#sel-monitor'), outputs.filter((d) => d.deviceId !== 'communications'), [], prefs.monitorId || 'default');
  const hasVirtual = outputs.some((d) => isVirtual(d.label));
  $('#output-hint').textContent = hasVirtual
    ? 'Then pick the matching cable output as your mic in OBS or Discord.'
    : 'No virtual cable found. Install VB-CABLE so OBS and Discord can hear MicPRO.';
}
navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices().catch(() => {}));

$('#sel-input').addEventListener('change', async (e) => {
  prefs.inputId = e.target.value; savePrefs();
  try { await engine.setInputDevice(prefs.inputId); } catch (err) { toast(`Couldn't open that microphone: ${err.message}`, true); }
});
$('#sel-output').addEventListener('change', async (e) => { prefs.outputId = e.target.value; savePrefs(); await engine.setOutputDevice(prefs.outputId); });
$('#sel-monitor').addEventListener('change', async (e) => { prefs.monitorId = e.target.value; savePrefs(); await engine.setMonitorDevice(prefs.monitorId); });
$('#monitor-vol').value = Math.round(prefs.monitorVolume * 100);
$('#monitor-vol').addEventListener('input', (e) => { prefs.monitorVolume = e.target.value / 100; savePrefs(); engine.setMonitor(prefs.monitorOn, prefs.monitorVolume); });
$('#sw-monitor').addEventListener('click', () => { prefs.monitorOn = !prefs.monitorOn; savePrefs(); engine.setMonitor(prefs.monitorOn, prefs.monitorVolume); renderTransport(); });
$$('#seg-channel button').forEach((b) => b.addEventListener('click', () => { prefs.inputChannel = b.dataset.v; savePrefs(); engine.setInputChannel(prefs.inputChannel); renderTransport(); }));

/* ------------------------------------------------------------------ */
/* transport                                                           */
/* ------------------------------------------------------------------ */
function renderTransport() {
  const on = engine.running;
  $('#btn-power').setAttribute('aria-pressed', on);
  $('#btn-power span').textContent = on ? 'On' : 'Turn on';
  const chip = $('#chip-engine'); chip.dataset.state = on ? 'on' : 'off'; $('b', chip).textContent = on ? 'Live' : 'Off';
  $('#scope-empty').hidden = on;
  $('#ab-proc').classList.toggle('on', !engine.bypass); $('#ab-proc').setAttribute('aria-checked', !engine.bypass);
  $('#ab-raw').classList.toggle('on', engine.bypass); $('#ab-raw').setAttribute('aria-checked', engine.bypass);
  $('#chip-bypass').hidden = !engine.bypass;
  $('#btn-mute').classList.toggle('on', engine.muted); $('#btn-mute').textContent = engine.muted ? 'Muted' : 'Mute';
  $('#chip-mute').hidden = !engine.muted;
  $('#sw-monitor').setAttribute('aria-checked', prefs.monitorOn);
  $$('#seg-channel button').forEach((b) => { const sel = b.dataset.v === prefs.inputChannel; b.classList.toggle('on', sel); b.setAttribute('aria-checked', sel); });
  ['#btn-autolevel', '#btn-rec', '#btn-learn'].forEach((s) => { $(s).disabled = !on; });
}

async function powerOn() {
  try {
    await engine.start({ inputId: prefs.inputId, outputId: prefs.outputId || '', monitorId: prefs.monitorId, inputChannel: prefs.inputChannel, settings });
    await engine.setMonitor(prefs.monitorOn, prefs.monitorVolume);
    await refreshDevices();
  } catch (err) {
    toast(err.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in your system privacy settings.' : `Couldn't start: ${err.message}`, true, 6000);
  }
  renderTransport();
}
$('#btn-power').addEventListener('click', async () => { if (engine.running) await engine.stop(); else await powerOn(); renderTransport(); });
$('#ab-proc').addEventListener('click', () => engine.setBypass(false));
$('#ab-raw').addEventListener('click', () => engine.setBypass(true));
$('#btn-mute').addEventListener('click', () => engine.setMute(!engine.muted));

$('#btn-autolevel').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const gain = await engine.autoLevel(5, (p) => { b.textContent = `Keep talking… ${Math.ceil(5 - p * 5)}s`; });
    settings.inputGain = gain; onSettingsChanged();
    toast(`Gain set to ${gain > 0 ? '+' : ''}${gain} dB`);
  } catch (err) { toast(err.message, true); }
  b.textContent = 'Auto-set gain'; b.disabled = !engine.running;
});

$('#btn-learn').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Stay quiet…';
  engine.learnNoise(2);
  setTimeout(() => { b.textContent = 'Learn room noise'; b.disabled = !engine.running; }, 2300);
});

/* recording */
let lastRec = null, recTimer = 0;
$('#btn-rec').addEventListener('click', async () => {
  const b = $('#btn-rec');
  if (!engine.isRecording) {
    engine.startRecording(); b.classList.add('on'); $('span', b).textContent = 'Stop';
    $('#rec-time').hidden = false;
    recTimer = setInterval(() => { const s = engine.recordingSeconds; $('#rec-time').textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; if (s > 600) b.click(); }, 200);
  } else {
    clearInterval(recTimer); b.classList.remove('on'); $('span', b).textContent = 'Record test'; $('#rec-time').hidden = true;
    lastRec = await engine.stopRecording();
    if (lastRec && lastRec.processed.length > 100) openRecDialog(); else toast('Nothing was recorded.', true);
  }
});

let player = null;
function stopPlayer() { if (player) { player.pause(); URL.revokeObjectURL(player.src); player = null; } }
async function play(which) {
  stopPlayer();
  const wav = encodeWav(lastRec[which], lastRec.sampleRate);
  player = new Audio(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
  if (player.setSinkId && prefs.monitorId) await player.setSinkId(prefs.monitorId).catch(() => {});
  player.play();
}
function openRecDialog() {
  const secs = lastRec.processed.length / lastRec.sampleRate;
  $('#rec-info').textContent = `${secs.toFixed(1)} seconds. Compare the raw mic with MicPRO, then save the take for your edit.`;
  const c = $('#rec-wave'); const dpr = devicePixelRatio || 1;
  c.width = c.clientWidth * dpr || 860; c.height = 90 * dpr;
  const g = c.getContext('2d'); g.clearRect(0, 0, c.width, c.height);
  const drawWave = (data, color, alpha) => {
    const w = c.width, h = c.height, step = Math.max(1, Math.floor(data.length / w));
    g.fillStyle = color; g.globalAlpha = alpha;
    for (let x = 0; x < w; x++) {
      let mn = 0, mx = 0;
      for (let i = x * step; i < (x + 1) * step && i < data.length; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      g.fillRect(x, h / 2 - mx * h / 2, 1, Math.max(1, (mx - mn) * h / 2));
    }
    g.globalAlpha = 1;
  };
  drawWave(lastRec.raw, '#8b8a78', 0.55);
  drawWave(lastRec.processed, '#ffb23e', 0.9);
  $('#dlg-rec').showModal();
}
$('#dlg-rec').addEventListener('close', stopPlayer);
$('#play-raw').addEventListener('click', () => play('raw'));
$('#play-proc').addEventListener('click', () => play('processed'));
$('#play-stop').addEventListener('click', stopPlayer);
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
$('#save-proc').addEventListener('click', async () => { const p = await bridge.saveFile(encodeWav(lastRec.processed, lastRec.sampleRate), `MicPRO-${stamp()}.wav`); if (p) toast('Saved processed take'); });
$('#save-raw').addEventListener('click', async () => { const p = await bridge.saveFile(encodeWav(lastRec.raw, lastRec.sampleRate), `MicPRO-raw-${stamp()}.wav`); if (p) toast('Saved raw take'); });

/* hotkeys */
bridge.onHotkey((a) => {
  if (a === 'mute') { engine.setMute(!engine.muted); toast(engine.muted ? 'Mic muted' : 'Mic live'); }
  if (a === 'bypass') { engine.setBypass(!engine.bypass); toast(engine.bypass ? 'Raw mic (bypassed)' : 'MicPRO processing'); }
});
async function applyHotkeys() {
  const res = await bridge.setHotkeys(prefs.hotkeys);
  const bad = Object.entries(res || {}).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) toast(`Couldn't register the ${bad.join(' and ')} hotkey. Another app may be using it.`, true, 5000);
}
const prettyKey = (a) => (a || 'Not set').replace('CommandOrControl', bridge.platform === 'darwin' ? '⌘' : 'Ctrl').replaceAll('+', ' + ');
function bindHotkeyInput(input, action) {
  input.value = prettyKey(prefs.hotkeys[action]);
  input.addEventListener('focus', () => { input.value = 'Press keys…'; });
  input.addEventListener('blur', () => { input.value = prettyKey(prefs.hotkeys[action]); });
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (e.key === 'Escape') return input.blur();
    if (e.key === 'Backspace') { prefs.hotkeys[action] = ''; savePrefs(); applyHotkeys(); return input.blur(); }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    const mods = [e.ctrlKey || e.metaKey ? 'CommandOrControl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
    if (!mods.length && !/^F\d+$/.test(e.key)) { input.value = 'Add Ctrl, Alt or Shift'; return; }
    const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    prefs.hotkeys[action] = [...mods, key].join('+'); savePrefs(); applyHotkeys(); input.blur();
  });
}
bindHotkeyInput($('#hk-mute'), 'mute');
bindHotkeyInput($('#hk-bypass'), 'bypass');
$('#opt-tray').checked = prefs.tray;
$('#opt-tray').addEventListener('change', (e) => { prefs.tray = e.target.checked; savePrefs(); bridge.setCloseToTray(prefs.tray); });
$('#opt-autostart').checked = prefs.autostart;
$('#opt-autostart').addEventListener('change', (e) => { prefs.autostart = e.target.checked; savePrefs(); });
$('#btn-settings').addEventListener('click', () => $('#dlg-settings').showModal());
$('#btn-help').addEventListener('click', () => $('#dlg-help').showModal());
$$('a[data-external]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); bridge.openExternal(a.href); }));

/* ------------------------------------------------------------------ */
/* EQ curve editor                                                     */
/* ------------------------------------------------------------------ */
const eqCanvas = $('#eq-canvas');
const EQ_MIN_F = 20, EQ_MAX_F = 20000, EQ_DB = 15;
const BANDS = [
  { id: 'hpf', name: 'Low cut', color: '#9c9a87', f: 'hpf.freq', on: 'hpf.on' },
  { id: 'low', name: 'Body', color: '#d9a15a', f: 'eq.low.freq', g: 'eq.low.gain' },
  { id: 'mud', name: 'Mud', color: '#e86d4c', f: 'eq.mud.freq', g: 'eq.mud.gain', q: 'eq.mud.q' },
  { id: 'presence', name: 'Presence', color: '#ffb23e', f: 'eq.presence.freq', g: 'eq.presence.gain', q: 'eq.presence.q' },
  { id: 'air', name: 'Air', color: '#a5e35c', f: 'eq.air.freq', g: 'eq.air.gain' },
  { id: 'lpf', name: 'High cut', color: '#9c9a87', f: 'eq.lpf.freq' },
];
const fx = (f, w) => (Math.log(f / EQ_MIN_F) / Math.log(EQ_MAX_F / EQ_MIN_F)) * w;
const xf = (x, w) => EQ_MIN_F * Math.pow(EQ_MAX_F / EQ_MIN_F, x / w);
const gy = (db, h) => h / 2 - (db / EQ_DB) * (h / 2 - 14);
const yg = (y, h) => ((h / 2 - y) / (h / 2 - 14)) * EQ_DB;

$('#eq-bands').innerHTML = BANDS.map((b) => `<div class="eq-band"><span class="sw" style="background:${b.color}"></span>${b.name}<b data-band="${b.id}"></b></div>`).join('');

function bandPos(b, w, h) {
  const f = getPath(settings, b.f);
  const g = b.g ? getPath(settings, b.g) : 0;
  return [fx(f, w), b.g ? gy(g, h) : h - 22];
}

function drawEq() {
  const dpr = devicePixelRatio || 1;
  const W = eqCanvas.clientWidth, H = eqCanvas.clientHeight;
  if (!W || !H) return;
  if (eqCanvas.width !== W * dpr) { eqCanvas.width = W * dpr; eqCanvas.height = H * dpr; }
  const g = eqCanvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = '11px Barlow, sans-serif'; g.fillStyle = '#6e6d5f';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = fx(f, W); g.strokeStyle = 'rgba(235,230,214,0.06)'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : f, x + 3, H - 6);
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = gy(db, H); g.strokeStyle = db === 0 ? 'rgba(235,230,214,0.16)' : 'rgba(235,230,214,0.05)';
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    if (db) g.fillText(`${db > 0 ? '+' : ''}${db}`, 4, y - 3);
  }
  const N = Math.max(64, Math.floor(W / 2));
  const freqs = Array.from({ length: N }, (_, i) => xf((i / (N - 1)) * W, W));
  const resp = engine.eqResponse(freqs, settings);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,178,62,0.32)'); grad.addColorStop(0.5, 'rgba(255,178,62,0.04)'); grad.addColorStop(1, 'rgba(255,178,62,0.0)');
  g.beginPath();
  freqs.forEach((f, i) => { const x = fx(f, W), y = Math.min(H + 5, Math.max(-5, gy(resp[i], H))); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.lineTo(W, gy(0, H)); g.lineTo(0, gy(0, H)); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath();
  freqs.forEach((f, i) => { const x = fx(f, W), y = Math.min(H + 5, Math.max(-5, gy(resp[i], H))); i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.strokeStyle = settings.eq.on ? '#ffb23e' : '#6e6d5f'; g.lineWidth = 2.2; g.stroke(); g.lineWidth = 1;

  for (const b of BANDS) {
    const [x, y] = bandPos(b, W, H);
    const active = eqDrag?.band === b || eqHover === b;
    g.beginPath(); g.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
    g.fillStyle = b.color; g.globalAlpha = 0.95; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = '#12140e'; g.lineWidth = 2; g.stroke(); g.lineWidth = 1;
  }
  for (const b of BANDS) {
    const el = $(`[data-band="${b.id}"]`);
    const f = formatVal(getPath(settings, b.f), 'Hz');
    el.textContent = b.g ? `${f}\n${formatVal(getPath(settings, b.g), 'dB')}` : b.id === 'hpf' && !settings.hpf.on ? 'Off' : b.id === 'lpf' && settings.eq.lpf.freq >= 19900 ? 'Off' : f;
  }
}
let eqDrag = null, eqHover = null;
const hit = (e) => {
  const r = eqCanvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = null, bd = 18;
  for (const b of BANDS) { const [bx, by] = bandPos(b, r.width, r.height); const d = Math.hypot(bx - x, by - y); if (d < bd) { bd = d; best = b; } }
  return { best, x, y, r };
};
eqCanvas.addEventListener('pointerdown', (e) => { const { best } = hit(e); if (!best) return; eqCanvas.setPointerCapture(e.pointerId); eqDrag = { band: best }; });
eqCanvas.addEventListener('pointermove', (e) => {
  const { best, x, y, r } = hit(e);
  if (!eqDrag) { if (eqHover !== best) { eqHover = best; drawEq(); } eqCanvas.style.cursor = best ? 'grab' : 'crosshair'; return; }
  const b = eqDrag.band;
  let f = Math.round(xf(Math.max(0, Math.min(r.width, x)), r.width));
  const lim = { hpf: [20, 400], low: [40, 600], mud: [120, 2000], presence: [1000, 9000], air: [4000, 18000], lpf: [2000, 20000] }[b.id];
  f = Math.max(lim[0], Math.min(lim[1], f));
  setPath(settings, b.f, f);
  if (b.on) setPath(settings, b.on, true);
  if (b.g) setPath(settings, b.g, Math.round(Math.max(-EQ_DB, Math.min(EQ_DB, yg(y, r.height))) * 2) / 2);
  $('#eq-readout').textContent = `${b.name}: ${formatVal(f, 'Hz')}${b.g ? ', ' + formatVal(getPath(settings, b.g), 'dB') : ''}`;
  onSettingsChanged();
});
eqCanvas.addEventListener('pointerup', () => { eqDrag = null; drawEq(); });
eqCanvas.addEventListener('pointerleave', () => { if (!eqDrag) { eqHover = null; drawEq(); } });
eqCanvas.addEventListener('wheel', (e) => {
  const { best } = hit(e);
  if (!best?.q) return;
  e.preventDefault();
  const q = Math.max(0.3, Math.min(6, getPath(settings, best.q) * (e.deltaY > 0 ? 0.9 : 1.1)));
  setPath(settings, best.q, Math.round(q * 100) / 100);
  $('#eq-readout').textContent = `${best.name} width: Q ${getPath(settings, best.q).toFixed(2)}`;
  onSettingsChanged();
}, { passive: false });
new ResizeObserver(() => drawEq()).observe(eqCanvas);

/* ------------------------------------------------------------------ */
/* live spectrum + meters                                              */
/* ------------------------------------------------------------------ */
const spec = $('#spectrum');
let specIn = new Float32Array(2048), specOut = new Float32Array(2048);
const peakHold = { in: -100, out: -100, outT: 0 };
let outPeakMax = -100, outPeakTime = 0;
const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function drawSpectrum() {
  const dpr = devicePixelRatio || 1;
  const W = spec.clientWidth, H = spec.clientHeight;
  if (spec.width !== W * dpr || spec.height !== H * dpr) { spec.width = W * dpr; spec.height = H * dpr; }
  const g = spec.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(235,230,214,0.05)';
  g.font = '11px Barlow, sans-serif'; g.fillStyle = '#5d5c50';
  for (const f of [100, 1000, 10000]) { const x = fx(f, W); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : f, x + 3, H - 6); }
  if (!engine.running || !engine.anIn) return;
  const n = engine.anIn.frequencyBinCount;
  if (specIn.length !== n) { specIn = new Float32Array(n); specOut = new Float32Array(n); }
  engine.spectrum(specIn, specOut);
  const sr = engine.ctx.sampleRate, binHz = sr / 2 / n;
  const MIN = -105, MAX = -15;
  const toY = (db) => H - ((Math.max(MIN, Math.min(MAX, db)) - MIN) / (MAX - MIN)) * (H - 8);
  const cols = Math.floor(W / 3);
  const column = (arr, i) => {
    const f0 = xf((i / cols) * W, W), f1 = xf(((i + 1) / cols) * W, W);
    const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0, Math.min(n - 1, Math.floor(f1 / binHz)));
    let m = -200; for (let b = b0; b <= b1; b++) if (arr[b] > m) m = arr[b];
    return m + 3 * Math.log2(Math.max(1, ((f0 + f1) / 2) / 1000) + 1); // gentle tilt so the voice reads evenly
  };
  // processed (filled)
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,178,62,0.75)'); grad.addColorStop(1, 'rgba(255,178,62,0.05)');
  g.beginPath(); g.moveTo(0, H);
  for (let i = 0; i <= cols; i++) g.lineTo((i / cols) * W, toY(column(specOut, Math.min(i, cols - 1))));
  g.lineTo(W, H); g.closePath(); g.fillStyle = grad; g.fill();
  // raw (line)
  g.beginPath();
  for (let i = 0; i <= cols; i++) { const x = (i / cols) * W, y = toY(column(specIn, Math.min(i, cols - 1))); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = 'rgba(190,188,168,0.55)'; g.lineWidth = 1.3; g.stroke(); g.lineWidth = 1;
}

function setMeter(id, lv, key) {
  const el = $(id), rms = $('.rms', el), pk = $('.pk', el);
  rms.style.height = `${dbToPct(lv.rms + 3)}%`;
  rms.style.setProperty('--h', `${el.querySelector('.meter-bar').clientHeight}px`);
  peakHold[key] = lv.peak > peakHold[key] ? lv.peak : peakHold[key] - 0.6;
  pk.style.bottom = `${dbToPct(peakHold[key])}%`;
}
const setGr = (id, db, range = 12) => { $(`${id} i`).style.width = `${Math.min(100, (Math.abs(db) / range) * 100)}%`; };

function frame() {
  try { renderFrame(); } catch (err) { console.error(err); }
  requestAnimationFrame(frame);
}
function renderFrame() {
  drawSpectrum();
  const m = engine.meters();
  if (m) {
    setMeter('#m-in', m.input, 'in'); setMeter('#m-out', m.output, 'out');
    $('#gr-gate .led-dot').classList.toggle('open', !!m.gate.open);
    setGr('#gr-deess', m.deess); setGr('#gr-comp', m.comp, 15); setGr('#gr-lim', m.limiter, 6);
    const now = performance.now();
    if (m.output.peak > outPeakMax || now - outPeakTime > 1500) { outPeakMax = m.output.peak; outPeakTime = now; }
    const op = $('#out-peak'); op.textContent = outPeakMax < -90 ? '–∞' : `${outPeakMax.toFixed(1)} dB`; op.classList.toggle('hot', outPeakMax > -0.3);
    if (typeof m.gate.env === 'number') {
      const pct = (db) => Math.max(0, Math.min(100, ((db + 90) / 80) * 100));
      $('#gate-env').style.width = `${pct(m.gate.env)}%`;
      $('#gate-thr').style.left = `${pct(settings.gate.threshold)}%`;
    }
  } else {
    $$('.meter .rms').forEach((r) => { r.style.height = '0%'; }); $$('.meter .pk').forEach((r) => { r.style.bottom = '0%'; });
    $$('.gr-bar i').forEach((r) => { r.style.width = '0%'; }); $('#gr-gate .led-dot').classList.remove('open');
    $('#gate-thr').style.left = `${Math.max(0, Math.min(100, ((settings.gate.threshold + 90) / 80) * 100))}%`;
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
(async function boot() {
  renderControls(); renderPresets(); renderTransport();
  bridge.setCloseToTray(prefs.tray);
  applyHotkeys();
  bridge.version().then((v) => { $('#about').textContent = `MicPRO ${v}. Processing runs locally; nothing leaves your computer.`; });
  try {
    // unlock device names
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch { /* handled when the user presses power */ }
  await refreshDevices().catch(() => {});
  savePrefs();
  requestAnimationFrame(frame);
  if (!prefs.seenHelp) { prefs.seenHelp = true; savePrefs(); $('#dlg-help').showModal(); }
  if (prefs.autostart) powerOn();
})();

// expose for debugging / tests
window.__micpro = { engine, get settings() { return settings; }, loadPreset };
