// ── Space: real rooms + front-to-back depth ───────────────────────────────────
// Replaces the old single ConvolverNode fed with generated white noise. Two ideas:
//
//   1. REAL IMPULSE RESPONSES. assets/ir/*.flac are prepared recordings of actual
//      spaces (see assets/ir/LICENSES.md, all MIT). manifest.json lists them.
//
//   2. THREE MIC POSITIONS, NOT ONE REVERB. A real mock-up gets its depth from
//      several mics at different distances. So we build exactly THREE shared
//      convolution busses from the SAME room IR — close / tree / far — at rising
//      pre-delays and falling brightness. A "seat" (pan + distance) decides how a
//      voice is mixed into those three, how much extra pre-delay it gets, how dark
//      it goes (air absorption), and how much its dry level drops. Something far
//      back is therefore later, darker, quieter and wetter — all at once.
//
// ConvolverNode is the expensive node, so there are only ever three of them no
// matter how many voices play. Everything per-voice is gains / delay / filter / pan.
//
// CONTRACT other modules code against:
//   initSpace(ctx, masterOut) -> {
//     sendFor(seat),   // seat = {pan:-1..1, distance:0..1} -> GainNode to connect a voice into
//     setRoom(id),     // switch impulse response
//     setAmount(0..1), // global wet
//     rooms,           // [{id,label,seconds,bytes}]
//     dispose()
//   }
// A voice connects to sendFor(seat) INSTEAD of its own reverb; dry stays on the
// master bus. seatFor(seat, dryDest) is the convenience wrapper that does both.

import { S } from './state.js';

// ── Room catalogue ────────────────────────────────────────────────────────────
// Baked in so the dropdown is correct on the very first frame (and still works if
// the manifest can't be fetched); refreshed from assets/ir/manifest.json on load.
// Regenerate with: python scripts/fetch_irs.py
export const SPACE_ROOMS = [
  { id: 'small-room', label: 'Small Room', file: 'small-room.flac', seconds: 0.535, channels: 2, rt60: 0.476, bytes: 41304, note: 'Hotel guest room, XY pair, balloon burst - tight, dry, close walls.' },
  { id: 'live-room', label: 'Live Room', file: 'live-room.flac', seconds: 0.516, channels: 2, rt60: 0.623, bytes: 44330, note: 'Open residential living room - wood floor slap, drum-friendly.' },
  { id: 'studio-chamber', label: 'Studio Chamber', file: 'studio-chamber.flac', seconds: 0.862, channels: 2, rt60: 1.079, bytes: 78493, note: 'Treated club room - diffuse, even decay, the classic echo-chamber send.' },
  { id: 'concert-hall', label: 'Concert Hall', file: 'concert-hall.flac', seconds: 3.759, channels: 2, rt60: 4.595, bytes: 305237, note: 'Large ballroom - long, wide, orchestral tail.' },
  { id: 'cathedral', label: 'Cathedral', file: 'cathedral.flac', seconds: 2.539, channels: 2, rt60: 4.007, bytes: 120173, note: 'The Pantheon, Rome - stone dome, enormous and dark.' },
  { id: 'plate', label: 'Steel Plate', file: 'plate.flac', seconds: 3.024, channels: 2, rt60: 3.25, bytes: 122865, note: 'Real steel reverb plate, swept - dense, metallic, no early reflections.' },
  { id: 'spring', label: 'Spring Tank', file: 'spring.flac', seconds: 2.6, channels: 2, rt60: 3.275, bytes: 131759, note: 'Combo-amp spring tank, swept - boingy, mid-forward, surf guitar.' },
  { id: 'cab', label: 'Amp Cab', file: 'cab.flac', seconds: 0.091, channels: 1, rt60: 0.128, bytes: 3492, note: 'Twin 12" combo cab, chorus off - speaker colour, not a room.' },
];

const IR_BASE = '/assets/ir/';
export const DEFAULT_ROOM = 'studio-chamber';
export const DEFAULT_AMOUNT = 0.20;
export const DEFAULT_DEPTH = 0.5;

// Named seats the UI offers. distance is the BASE distance; the Depth control
// scales it, so Depth 0 collapses the mix flat and Depth 1 spreads it fully.
export const SEATS = {
  near: { label: 'near', distance: 0.12 },
  mid:  { label: 'mid',  distance: 0.45 },
  far:  { label: 'far',  distance: 0.85 },
};
export const SEAT_IDS = ['near', 'mid', 'far'];

// ── Physical model ────────────────────────────────────────────────────────────
const ROOM_DEPTH_M   = 12;      // metres between distance 0 and distance 1
const MS_PER_METRE   = 1 / 0.34; // ~1 ms per 34 cm — the brief's rule of thumb
const AIR_TOP_HZ     = 19000;   // open at distance 0: audibly transparent
const AIR_FAR_RATIO  = 0.16;    // 19 kHz -> ~3 kHz at the back of the room
const DRY_FALLOFF    = 1.3;     // dry level = 1/(1 + DRY_FALLOFF * d)
const WET_BASE       = 0.40;    // send level at distance 0
const WET_SPAN       = 1.45;    // extra send level by distance 1
const BUS_BLEED      = 0.16;    // every seat keeps a little of all three mics (glue)

// The three shared convolution busses: one room, three mic positions.
const BUSSES = [
  { id: 'close', label: 'close mic', preDelay: 0.004, trim: 1.00, tone: 16000 },
  { id: 'tree',  label: 'tree (mid)', preDelay: 0.022, trim: 0.92, tone: 10000 },
  { id: 'far',   label: 'far / room', preDelay: 0.055, trim: 0.82, tone: 6000 },
];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/** Mic-bus weights for a distance: a triangular crossfade plus a little bleed. */
export function busWeights(d) {
  d = clamp(num(d, 0), 0, 1);
  let a = clamp(1 - 2 * d, 0, 1) + BUS_BLEED;
  let b = 1 - Math.abs(2 * d - 1) + BUS_BLEED;
  let c = clamp(2 * d - 1, 0, 1) + BUS_BLEED;
  const s = a + b + c;
  return [a / s, b / s, c / s];
}

/** Everything a distance implies, in one place so the offline render matches. */
export function seatPhysics(distance, depth = DEFAULT_DEPTH) {
  const d = clamp(num(distance, 0), 0, 1) * clamp(num(depth, DEFAULT_DEPTH), 0, 1);
  return {
    d,
    metres:  d * ROOM_DEPTH_M,
    preDelay: (d * ROOM_DEPTH_M * MS_PER_METRE) / 1000,            // seconds
    airHz:   AIR_TOP_HZ * Math.pow(AIR_FAR_RATIO, Math.pow(d, 1.5)),
    dryGain: 1 / (1 + DRY_FALLOFF * d),
    sendGain: WET_BASE + WET_SPAN * d,
    weights: busWeights(d),
  };
}

// ── IR loading ────────────────────────────────────────────────────────────────
const irBytes = new Map();      // id -> ArrayBuffer (encoded FLAC, fetched once)
const irDecoded = new Map();    // `${id}@${sampleRate}` -> AudioBuffer
let manifestPromise = null;
export let manifest = null;

export function prefetchSpace() {
  if (manifestPromise) return manifestPromise;
  manifestPromise = fetch(IR_BASE + 'manifest.json', { cache: 'force-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(m => {
      if (m && Array.isArray(m.rooms) && m.rooms.length) {
        manifest = m;
        SPACE_ROOMS.length = 0;
        for (const r of m.rooms) SPACE_ROOMS.push(r);
      }
      return manifest;
    })
    .catch(e => { console.warn('[space] manifest unavailable, using the built-in list:', e); return null; });
  // warm the default room's bytes so the first play already has a real room
  fetchIr(DEFAULT_ROOM).catch(() => {});
  return manifestPromise;
}

export function roomInfo(id) {
  return SPACE_ROOMS.find(r => r.id === id) || SPACE_ROOMS.find(r => r.id === DEFAULT_ROOM) || SPACE_ROOMS[0];
}

async function fetchIr(id) {
  if (irBytes.has(id)) return irBytes.get(id);
  const info = roomInfo(id);
  const res = await fetch(IR_BASE + (info.file || id + '.flac'), { cache: 'force-cache' });
  if (!res.ok) throw new Error(`IR ${id}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  irBytes.set(id, buf);
  return buf;
}

/** Last-resort IR so a decode failure degrades to "a reverb" instead of silence. */
function syntheticIr(ctx, seconds = 1.5) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const ir = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 1.8);
  }
  return ir;
}

/**
 * Decode a room for one context. Cached per (room, sampleRate) — the same
 * AudioBuffer is then reused by the live graph and by every offline render that
 * happens to run at the same rate, so switching rooms never re-decodes.
 */
export async function decodeRoom(ctx, id) {
  const key = `${id}@${ctx.sampleRate}`;
  if (irDecoded.has(key)) return irDecoded.get(key);
  let buf;
  try {
    const bytes = await fetchIr(id);
    buf = await ctx.decodeAudioData(bytes.slice(0));
  } catch (e) {
    console.warn(`[space] could not decode room "${id}" — falling back to a synthetic tail:`, e);
    buf = syntheticIr(ctx, roomInfo(id).seconds || 1.5);
  }
  irDecoded.set(key, buf);
  return buf;
}

// ── Persisted settings (project.json "space" block) ───────────────────────────
const state = {
  room: DEFAULT_ROOM,
  amount: DEFAULT_AMOUNT,
  depth: DEFAULT_DEPTH,
  live: 'near',                                  // the live instrument bus's seat
  slots: Array.from({ length: 6 }, () => 'near'), // one per loop slot
  pans: Array.from({ length: 6 }, () => 0),       // per-slot pan, -1..1 (0 = centre)
};

/** Snapshot for project.json. */
export function spaceState() {
  return {
    room: state.room, amount: state.amount, depth: state.depth,
    live: state.live, slots: state.slots.slice(), pans: state.pans.slice(),
  };
}

/**
 * Restore from project.json. A project saved before Space existed has no `space`
 * block at all — every field then keeps its default, which is the sane, close,
 * lightly-wet mix, so old projects load and sound right.
 */
export function applySpaceState(p) {
  const o = p || {};
  const roomOk = SPACE_ROOMS.some(r => r.id === o.room);
  state.room = roomOk ? o.room : DEFAULT_ROOM;
  state.amount = clamp(num(o.amount, DEFAULT_AMOUNT), 0, 1);
  state.depth = clamp(num(o.depth, DEFAULT_DEPTH), 0, 1);
  state.live = SEAT_IDS.includes(o.live) ? o.live : 'near';
  for (let i = 0; i < 6; i++) {
    const v = Array.isArray(o.slots) ? o.slots[i] : null;
    state.slots[i] = SEAT_IDS.includes(v) ? v : 'near';
    state.pans[i] = clamp(num(Array.isArray(o.pans) ? o.pans[i] : 0, 0), -1, 1);
  }
  applyStateToGraph();
  renderSpaceUI();
}

export const spaceDepth = () => state.depth;
export const spaceAmount = () => state.amount;
export const spaceRoomId = () => state.room;
export const slotSeatId = i => state.slots[i] || 'near';

/** The seat object for a loop slot — what sendFor()/seatFor() take. */
export function slotSeat(i) {
  return { pan: state.pans[i] ?? 0, distance: SEATS[slotSeatId(i)].distance, name: slotSeatId(i) };
}
export function liveSeat() {
  return { pan: 0, distance: SEATS[state.live]?.distance ?? SEATS.near.distance, name: state.live };
}

// ── The space graph ───────────────────────────────────────────────────────────
/**
 * Build one space. Works in an AudioContext or an OfflineAudioContext, which is
 * how an exported WAV ends up with the same room as the live monitor path.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} masterOut  where the WET returns (the dry path never passes through here)
 * @param {object} [opts] {room, amount, depth, dryDest}
 */
export function initSpace(ctx, masterOut, opts = {}) {
  const room = SPACE_ROOMS.some(r => r.id === opts.room) ? opts.room : state.room;
  let amount = clamp(num(opts.amount, state.amount), 0, 1);
  let depth = clamp(num(opts.depth, state.depth), 0, 1);
  const defaultDry = opts.dryDest || masterOut;

  const wetSum = ctx.createGain(); wetSum.gain.value = 1;
  const amountGain = ctx.createGain(); amountGain.gain.value = amount;
  wetSum.connect(amountGain);
  if (masterOut) amountGain.connect(masterOut);

  // The three — and only three — ConvolverNodes.
  const busses = BUSSES.map(spec => {
    const input = ctx.createGain(); input.gain.value = 1;
    const pre = ctx.createDelay(0.5); pre.delayTime.value = spec.preDelay;
    const conv = ctx.createConvolver(); conv.normalize = true;
    const tone = ctx.createBiquadFilter(); tone.type = 'lowpass';
    tone.frequency.value = spec.tone; tone.Q.value = 0.5;
    const out = ctx.createGain(); out.gain.value = spec.trim;
    input.connect(pre); pre.connect(conv); conv.connect(tone); tone.connect(out); out.connect(wetSum);
    return { ...spec, input, pre, conv, tone, out };
  });

  const seats = new Set();
  let disposed = false;
  let roomId = room;

  const applyBuffer = buf => { for (const b of busses) b.conv.buffer = buf; };

  // Load the room. Until it lands the convolvers have no buffer, which in Web Audio
  // means they pass nothing — so the mix is simply dry for a moment, never broken.
  const ready = (async () => {
    await prefetchSpace();
    if (disposed) return;
    applyBuffer(await decodeRoom(ctx, roomId));
  })().catch(e => console.warn('[space] room load failed:', e));

  function tuneSeat(seat, chain) {
    const ph = seatPhysics(seat?.distance, depth);
    const pan = clamp(num(seat?.pan, 0), -1, 1);
    const t = ctx.currentTime;
    const set = (p, v) => { if (p) { try { p.setTargetAtTime(v, t, 0.012); } catch (_) { p.value = v; } } };
    set(chain.sendPre?.delayTime, ph.preDelay);
    set(chain.sendAir?.frequency, ph.airHz);
    set(chain.sendLvl?.gain, ph.sendGain);
    set(chain.sendPan?.pan, pan);
    if (chain.busGains) for (let i = 0; i < 3; i++) set(chain.busGains[i].gain, ph.weights[i]);
    set(chain.dryAir?.frequency, ph.airHz);
    set(chain.dryLvl?.gain, ph.dryGain);
    set(chain.dryPan?.pan, pan);
    chain.seat = seat;           // remembered so setDepth() can re-tune every seat
    chain.physics = ph;
  }

  /** CONTRACT: a GainNode to connect a voice into. No convolver is created here. */
  function sendFor(seat) {
    const tap = ctx.createGain(); tap.gain.value = 1;
    const sendAir = ctx.createBiquadFilter(); sendAir.type = 'lowpass'; sendAir.Q.value = 0.5;
    const sendLvl = ctx.createGain();
    const sendPre = ctx.createDelay(0.5);
    const sendPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const busGains = busses.map(() => ctx.createGain());

    tap.connect(sendAir); sendAir.connect(sendLvl); sendLvl.connect(sendPre);
    const head = sendPan ? (sendPre.connect(sendPan), sendPan) : sendPre;
    busGains.forEach((g, i) => { head.connect(g); g.connect(busses[i].input); });

    const chain = { tap, sendAir, sendLvl, sendPre, sendPan, busGains, nodes: [tap, sendAir, sendLvl, sendPre, sendPan, ...busGains] };
    tuneSeat(seat, chain);
    seats.add(chain);

    tap.setSeat = s => tuneSeat(s, chain);
    tap.releaseSeat = () => release(chain);
    tap.physics = () => chain.physics;
    return tap;
  }

  /** The dry half of a seat: pan + air absorption + distance level drop. */
  function dryFor(seat, dryDest = defaultDry) {
    const tap = ctx.createGain(); tap.gain.value = 1;
    const dryAir = ctx.createBiquadFilter(); dryAir.type = 'lowpass'; dryAir.Q.value = 0.5;
    const dryLvl = ctx.createGain();
    const dryPan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    tap.connect(dryAir); dryAir.connect(dryLvl);
    if (dryPan) { dryLvl.connect(dryPan); if (dryDest) dryPan.connect(dryDest); }
    else if (dryDest) dryLvl.connect(dryDest);

    const chain = { dryAir, dryLvl, dryPan, nodes: [tap, dryAir, dryLvl, dryPan] };
    tuneSeat(seat, chain);
    seats.add(chain);
    tap.setSeat = s => tuneSeat(s, chain);
    tap.releaseSeat = () => release(chain);
    return tap;
  }

  /**
   * Both halves behind ONE input node: connect a voice here and it is placed in
   * the room — dry (panned, air-filtered, level-dropped) to dryDest, and wet into
   * the three shared mic busses.
   */
  function seatFor(seat, dryDest = defaultDry) {
    const input = ctx.createGain(); input.gain.value = 1;
    const dry = dryFor(seat, dryDest);
    const send = sendFor(seat);
    input.connect(dry); input.connect(send);
    input.setSeat = s => { dry.setSeat(s); send.setSeat(s); };
    input.releaseSeat = () => { dry.releaseSeat(); send.releaseSeat(); try { input.disconnect(); } catch (_) {} };
    input.physics = () => send.physics();
    return input;
  }

  function release(chain) {
    seats.delete(chain);
    for (const n of chain.nodes || []) { try { n && n.disconnect(); } catch (_) {} }
  }

  async function setRoom(id) {
    if (disposed) return;
    const info = roomInfo(id);
    if (!info || info.id === roomId) { roomId = info ? info.id : roomId; return; }
    roomId = info.id;
    const buf = await decodeRoom(ctx, roomId);
    if (disposed || roomId !== info.id) return;
    // Dip the wet for ~35 ms around the buffer swap: a ConvolverNode drops its tail
    // state when its buffer changes, and the dip keeps that from being a click.
    const p = amountGain.gain;
    if (ctx.currentTime > 0 && amount > 0) {
      const t = ctx.currentTime;
      try {
        p.cancelScheduledValues(t);
        p.setValueAtTime(p.value, t);
        p.linearRampToValueAtTime(0, t + 0.03);
      } catch (_) { p.value = 0; }
      await new Promise(r => setTimeout(r, 40));
      if (disposed) return;
      applyBuffer(buf);
      const t2 = ctx.currentTime;
      try {
        p.cancelScheduledValues(t2);
        p.setValueAtTime(0, t2);
        p.linearRampToValueAtTime(amount, t2 + 0.07);
      } catch (_) { p.value = amount; }
    } else {
      applyBuffer(buf);
    }
  }

  function setAmount(a) {
    amount = clamp(num(a, 0), 0, 1);
    const p = amountGain.gain;
    try { p.setTargetAtTime(amount, ctx.currentTime, 0.02); } catch (_) { p.value = amount; }
  }

  /** Re-tune every live seat — used by the Depth slider and by seat changes. */
  function setDepth(d) {
    depth = clamp(num(d, DEFAULT_DEPTH), 0, 1);
    retune();
  }

  function retune() {
    for (const chain of seats) {
      // the seat object is re-read by the owner through setSeat; here we only need
      // to re-apply the physics for the distance already stored on the chain
      if (chain.seat) tuneSeat(chain.seat, chain);
    }
  }

  function dispose() {
    disposed = true;
    for (const chain of [...seats]) release(chain);
    for (const b of busses) {
      for (const n of [b.input, b.pre, b.conv, b.tone, b.out]) { try { n.disconnect(); } catch (_) {} }
      b.conv.buffer = null;
    }
    try { wetSum.disconnect(); amountGain.disconnect(); } catch (_) {}
  }

  const handle = {
    sendFor, dryFor, seatFor, setRoom, setAmount, setDepth, dispose, ready,
    rooms: SPACE_ROOMS,
    get roomId() { return roomId; },
    get amount() { return amount; },
    get depth() { return depth; },
    busses, convolvers: busses.map(b => b.conv),
    stats: () => ({ convolvers: busses.length, seats: seats.size }),
  };
  return handle;
}

// ── The live space ────────────────────────────────────────────────────────────
let live = null;                    // the handle for S.ctx
const slotChains = new Array(6).fill(null);
let liveChain = null;

export function getSpace() { return live; }

/** Called from core.js ensureCtx(), right after the master bus exists. */
export function installSpace(ctx, masterOut) {
  if (live) return live;
  live = initSpace(ctx, masterOut, { room: state.room, amount: state.amount, depth: state.depth });
  renderSpaceUI();
  return live;
}

/**
 * Place a loop slot in the room: its gain node's dry output goes on to dryDest
 * (the loop bus, exactly as before), and a parallel send feeds the mic busses.
 * Returns a handle with setSeat()/dispose(); safe to call before the space exists.
 */
export function seatForSlot(slot, dryDest) {
  if (!live) return null;
  const i = slot.id | 0;
  if (slotChains[i]) { try { slotChains[i].releaseSeat(); } catch (_) {} }
  const node = live.seatFor(slotSeat(i), dryDest || S.loopBus);
  slotChains[i] = node;
  return node;
}

export function seatForLive(srcNode, dryDest) {
  if (!live) return null;
  if (liveChain) { try { liveChain.releaseSeat(); } catch (_) {} }
  liveChain = live.seatFor(liveSeat(), dryDest || S.masterOut);
  try { srcNode.connect(liveChain); } catch (e) { console.warn('[space] live seat:', e); }
  return liveChain;
}

function applyStateToGraph() {
  if (!live) return;
  live.setAmount(state.amount);
  live.setDepth(state.depth);
  live.setRoom(state.room);
  for (let i = 0; i < 6; i++) slotChains[i]?.setSeat(slotSeat(i));
  liveChain?.setSeat(liveSeat());
}

// ── UI (the looper.html space:start / space:end block) ────────────────────────
const el = id => document.getElementById(id);
const pct = v => Math.round(v * 100) + '%';

export function setSpaceRoom(id) {
  const info = roomInfo(id);
  state.room = info.id;
  live?.setRoom(info.id);
  renderSpaceMeta();
}

export function setSpaceDepth(v) {
  state.depth = clamp(parseFloat(v), 0, 1);
  live?.setDepth(state.depth);
  const o = el('spaceDepthVal');
  if (o) o.textContent = pct(state.depth);
  renderSpaceMeta();
}

/** Wet amount. Driven by the migrated master Reverb slider via core.setGlobalFX(). */
export function setSpaceAmount(v) {
  state.amount = clamp(num(parseFloat(v), 0), 0, 1);
  live?.setAmount(state.amount);
}

export function setSlotSeat(i, seatId) {
  i = i | 0;
  if (i < 0 || i > 5 || !SEAT_IDS.includes(seatId)) return;
  state.slots[i] = seatId;
  slotChains[i]?.setSeat(slotSeat(i));
  paintSeatRow(i);
  renderSpaceMeta();
}

export function setLiveSeat(seatId) {
  if (!SEAT_IDS.includes(seatId)) return;
  state.live = seatId;
  liveChain?.setSeat(liveSeat());
  paintSeatRow(-1);
}

function seatButtons(idx) {
  const call = idx < 0 ? `setLiveSeat('%s')` : `setSlotSeat(${idx},'%s')`;
  return SEAT_IDS.map(sid =>
    `<button class="sp-seat" data-seat="${sid}" onclick="${call.replace('%s', sid)}"
             title="${idx < 0 ? 'Where you are playing from' : 'Loop ' + (idx + 1)}: ${sid} — ${Math.round(SEATS[sid].distance * ROOM_DEPTH_M)} m back">${SEATS[sid].label}</button>`
  ).join('');
}

function paintSeatRow(idx) {
  const row = el(idx < 0 ? 'spaceLiveSeats' : 'spaceSeat-' + idx);
  if (!row) return;
  const want = idx < 0 ? state.live : state.slots[idx];
  row.querySelectorAll('.sp-seat').forEach(b => b.classList.toggle('on', b.dataset.seat === want));
}

function renderSpaceMeta() {
  const info = roomInfo(state.room);
  const meta = el('spaceMeta');
  if (meta) {
    meta.textContent = `${info.seconds.toFixed(2)} s tail · RT60 ${(info.rt60 ?? 0).toFixed(2)} s · ${(info.bytes / 1024).toFixed(0)} KiB · ${info.channels === 1 ? 'mono' : 'stereo'}`;
    meta.title = info.note || '';
  }
  const stat = el('spaceStat');
  if (stat) {
    const back = state.slots.filter(s => s !== 'near').length;
    stat.textContent = `3 mic busses (close · tree · far) · up to ${Math.round(ROOM_DEPTH_M * state.depth)} m deep`
      + (back ? ` · ${back} loop${back === 1 ? '' : 's'} pushed back` : ' · every loop up front');
  }
}

let uiBuilt = false;
export function renderSpaceUI() {
  const sel = el('spaceRoom');
  if (!sel) return;
  sel.innerHTML = SPACE_ROOMS.map(r =>
    `<option value="${r.id}">${r.label} — ${r.seconds.toFixed(2)}s · ${(r.bytes / 1024).toFixed(0)}K</option>`).join('');
  sel.value = state.room;

  const grid = el('spaceSlotSeats');
  if (grid) {
    grid.innerHTML = Array.from({ length: 6 }, (_, i) =>
      `<div class="sp-seat-row"><span class="sp-seat-lbl" title="Loop ${i + 1}">L${i + 1}</span>
         <span class="sp-seat-btns" id="spaceSeat-${i}">${seatButtons(i)}</span></div>`).join('');
  }
  const liveRow = el('spaceLiveSeats');
  if (liveRow && !liveRow.children.length) liveRow.innerHTML = seatButtons(-1);

  for (let i = 0; i < 6; i++) paintSeatRow(i);
  paintSeatRow(-1);

  const dv = el('spaceDepthVal'); if (dv) dv.textContent = pct(state.depth);
  const ds = el('spaceDepth'); if (ds) ds.value = state.depth;
  const rs = el('revSlider'); if (rs && !uiBuilt) { rs.value = state.amount; }
  const rv = el('revVal'); if (rv && !uiBuilt) rv.textContent = pct(state.amount);
  uiBuilt = true;
  renderSpaceMeta();
}

// ── Offline render parity ─────────────────────────────────────────────────────
/**
 * Rebuild the same space inside an OfflineAudioContext so an exported WAV has the
 * room in it. Awaits the IR decode, so the convolvers are loaded before rendering
 * starts (an OfflineAudioContext renders in one shot — a late buffer would be lost).
 *
 * @returns {Promise<object>} the same handle shape as initSpace, plus .seatFor()
 */
export async function buildOfflineSpace(offCtx, dest, opts = {}) {
  const sp = initSpace(offCtx, dest, {
    room: opts.room ?? state.room,
    amount: opts.amount ?? state.amount,
    depth: opts.depth ?? state.depth,
    dryDest: opts.dryDest || dest,
  });
  await sp.ready;
  return sp;
}

/** What the offline renders should use. */
export function offlineSpaceOpts() {
  return { room: state.room, amount: state.amount, depth: state.depth };
}

// ── Boot ──────────────────────────────────────────────────────────────────────
Object.assign(window, { setSpaceRoom, setSpaceDepth, setSlotSeat, setLiveSeat });
prefetchSpace().then(() => renderSpaceUI());
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderSpaceUI, { once: true });
else renderSpaceUI();
// read-only handle for the automated audio tests
window.__space = { getSpace, initSpace, buildOfflineSpace, seatPhysics, busWeights, SPACE_ROOMS, spaceState, decodeRoom };
