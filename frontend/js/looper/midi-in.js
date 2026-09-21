// ── Web MIDI input ────────────────────────────────────────────────────────────
// Plug in a MIDI keyboard / pad controller and play the synth + drum pads.
// Notes go through the SAME noteOn/noteOff/hitDrum path as the computer keyboard,
// so they feed S.inputBus → the loop recorder (recording captures MIDI playing),
// honor the arpeggiator, ADSR, filter, instrument and scale lock.
//   · note-on velocity → voice gain
//   · CC64 sustain pedal holds released notes until the pedal lifts
//   · channel 10 (GM drums), or the "MIDI → Drums" toggle, plays the 8 drum pads
import { S } from './state.js';
import { setStatus } from './util.js';
import { noteOn, noteOff, WHITE_KEYS, BLACK_KEYS } from './synth.js';
import { DRUMS, hitDrum } from './drums.js';
import { NOTE_NAMES } from './scale.js';
import { gmToPad } from './gm.js';

let access = null;            // MIDIAccess
let selected = 'all';         // input id, or 'all'
const held = new Set();       // MIDI notes whose key is physically down
const sustained = new Set();  // released while the pedal was down → release on pedal-up
let sustainDown = false;

// GM percussion → pad index lives in gm.js (shared with MIDI file import/export)
export { gmToPad };

// A note object noteOn/noteOff understand. noteOn multiplies hz by 2^(OCT-4) and
// computes the sample pitch from `semi` + OCT, so divide the OCT shift back out:
// MIDI note 60 always sounds middle C regardless of the OCT control.
export function midiNoteObj(m, vel) { return noteObj(m, vel); }   // shared with Air Band (airband.js)
function noteObj(m, vel) {
  const shift = (S.octave - 4) * 12;
  return { note: keyName(m), hz: 440 * Math.pow(2, (m - 69 - shift) / 12), semi: m - 60 - shift, uid: 'midi_' + m, vel };
}

// The on-screen key id for MIDI note m (so the key lights up), if it's visible.
function keyName(m) {
  const rel = m - (S.octave + 1) * 12;               // 0 = the C at the keyboard's left edge
  if (rel >= 0 && rel <= 12) {
    const k = [...WHITE_KEYS, ...BLACK_KEYS].find(n => n.semi === rel);
    if (k) return k.note;
  }
  if (rel > 12 && rel <= 24) return NOTE_NAMES[rel % 12] + (rel === 24 ? S.octave + 2 : S.octave + 1);
  return 'midi' + m;                                  // off-screen: no key to light
}

function release(m) {
  noteOff(noteObj(m, 0));
}

// ── Message handler (exported so it can be driven in tests) ───────────────────
export function handleMidiMessage(data) {
  if (!data || data.length < 1) return;
  const status = data[0], type = status & 0xF0, ch = status & 0x0F;
  const d1 = data[1] ?? 0, d2 = data[2] ?? 0;
  const drums = ch === 9 || S.midiDrums;

  if (type === 0x90 && d2 > 0) {                      // note on
    flash();
    if (drums) { hitDrum(DRUMS[gmToPad(d1)], d2 / 127); return; }
    if (held.has(d1) || sustained.has(d1)) { sustained.delete(d1); release(d1); }   // re-strike
    held.add(d1);
    noteOn(noteObj(d1, d2 / 127));
  } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {   // note off
    if (drums) return;                                // drums are one-shots
    if (!held.delete(d1)) return;
    if (sustainDown) sustained.add(d1);
    else release(d1);
  } else if (type === 0xB0) {                         // control change
    if (d1 === 64) {                                  // sustain pedal
      const down = d2 >= 64;
      if (sustainDown && !down) { sustained.forEach(release); sustained.clear(); }
      sustainDown = down;
    } else if (d1 === 120 || d1 === 123) {            // all sound / all notes off
      [...held, ...sustained].forEach(release); held.clear(); sustained.clear();
    }
  }
}

function onMessage(e) {
  if (selected !== 'all' && e.currentTarget?.id !== selected && e.target?.id !== selected) return;
  handleMidiMessage(e.data);
}

// ── Device list + status ──────────────────────────────────────────────────────
function inputs() { return access ? [...access.inputs.values()] : []; }

function setStat(msg, cls) {
  const el = document.getElementById('midiStat');
  if (el) { el.textContent = msg; el.className = 'midi-stat' + (cls ? ' ' + cls : ''); }
}

function refreshDevices() {
  const sel = document.getElementById('midiDev');
  const list = inputs().filter(i => i.state !== 'disconnected');
  if (sel) {
    sel.innerHTML = '';
    sel.appendChild(new Option(list.length ? `All inputs (${list.length})` : 'No devices', 'all'));
    list.forEach(i => sel.appendChild(new Option(i.name || i.id, i.id)));
    if (selected !== 'all' && !list.some(i => i.id === selected)) selected = 'all';
    sel.value = selected;
    sel.disabled = !list.length;
  }
  // (re)attach listeners — every input stays bound; onMessage filters by selection
  inputs().forEach(i => { i.onmidimessage = onMessage; });
  if (!list.length) setStat('No MIDI devices — plug one in (hot-plug works)', 'warn');
  else setStat(list.length === 1 ? 'Connected: ' + (list[0].name || 'MIDI device') : `Connected: ${list.length} devices`, 'ok');
  const btn = document.getElementById('midiConnBtn');
  if (btn) { btn.classList.add('on'); btn.textContent = '🎹 MIDI on'; }
}

export async function connectMidi() {
  if (!navigator.requestMIDIAccess) {
    setStat('Web MIDI not supported here — use Chrome or Edge', 'err');
    const btn = document.getElementById('midiConnBtn'); if (btn) btn.disabled = true;
    return false;
  }
  if (access) { refreshDevices(); return true; }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    setStat('MIDI access denied — allow MIDI for this site in the browser settings', 'err');
    return false;
  }
  access.onstatechange = e => {                        // hot-plug
    refreshDevices();
    const p = e.port;
    if (p && p.type === 'input') setStatus(`MIDI ${p.state === 'connected' ? 'connected' : 'disconnected'}: ${p.name || 'device'}`);
  };
  refreshDevices();
  return true;
}

export function setMidiDevice(id) {
  selected = id || 'all';
  [...held, ...sustained].forEach(release); held.clear(); sustained.clear();
}

export function toggleMidiDrums() {
  S.midiDrums = !S.midiDrums;
  document.getElementById('midiDrumBtn')?.classList.toggle('on', S.midiDrums);
  setStatus(S.midiDrums ? 'MIDI → Drums: every note plays a drum pad (GM map)' : 'MIDI → Synth (channel 10 still plays drums)');
}

let flashT = 0;
function flash() {
  const dot = document.getElementById('midiDot'); if (!dot) return;
  dot.classList.add('hit'); clearTimeout(flashT);
  flashT = setTimeout(() => dot.classList.remove('hit'), 90);
}

// On load: connect silently only if MIDI was already granted (no permission prompt
// on page load); otherwise show the Connect button + a hint.
export async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    setStat('Web MIDI not supported here — use Chrome or Edge', 'err');
    const btn = document.getElementById('midiConnBtn'); if (btn) btn.disabled = true;
    return;
  }
  let granted = false;
  try { granted = (await navigator.permissions.query({ name: 'midi' })).state === 'granted'; } catch (_) {}
  if (granted) connectMidi();
  else setStat('Click Connect to use a MIDI keyboard / pads');
}
