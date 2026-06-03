// ── Shared mutable state ──────────────────────────────────────────────────────
// Every module-level `let` that is written from more than one place (or that must
// stay in sync across modules) lives here. Mutating a property of S propagates
// across modules; reassigning an imported binding would NOT — so always use S.x.

export const S = {
  // ── Audio context & buses ──
  ctx: null,
  inputBus: undefined,
  loopBus: undefined,
  masterOut: undefined,
  captureNode: undefined,
  captureOutGain: undefined,
  inputClip: undefined,     // soft clipper between inputBus and the recorder
  bypassGain: undefined,
  reverbNode: undefined,
  reverbGain: undefined,
  delayFX: undefined,
  delayFB: undefined,
  delayGain: undefined,
  capturing: false,
  bypassed: false,
  captureChunks: null,

  // ── Autotune ──
  autotuneNode: null,
  autotuneOn: false,
  atRoot: 0,
  atSpeed: 0.92,
  atScale: null,            // set to AT_SCALES.major in mic.js init

  // ── Loop slots ──
  masterLen: null,          // seconds
  masterAnchor: null,       // ctx.currentTime when master loop t=0
  masterSlot: -1,
  slots: [],

  // ── Drag / glissando ──
  isMouseDown: false,

  // ── Synth keyboard ──
  wave: 'sine',
  octave: 4,                // 1–7; frequencies scale as 2^(octave-4) relative to base
  guitarMode: false,
  guitarVol: 0.28,
  sampleBuffer: null,
  sampleMode: false,
  // ADSR envelope (A/D/R in ms, S as 0–1 level)
  attackMs: 8,
  decayMs: 150,
  sustainLevel: 0.70,
  releaseMs: 200,
  // Subtractive lowpass filter (applied to osc + sample voices)
  filterCutoff: 16000,      // Hz; ~open by default
  filterReso: 0.7,          // Q
  // Arpeggiator
  arpOn: false,
  arpDiv: 4,                // steps per beat: 2 = 1/8, 4 = 1/16
  arpMode: 'up',            // up | down | updown | random
  arpHeld: [],              // note objects currently held
  arpIdx: 0,
  arpDir: 1,
  arpTimer: null,
  _arpFiring: false,
  // Count-in
  countIn: 2,
  activeOsc: {},
  upperKeyMap: {},          // rebuilt by buildKbd on every octave change

  // ── Microphone ──
  micOn: false,
  micStream: null,
  micSrc: null,
  micAna: null,

  // ── Metronome ──
  bpm: 120,
  metroOn: false,
  metroBeat: 0,
  metroTid: null,

  // ── Step sequencer ──
  seqPattern: Array.from({ length: 8 }, () => new Array(16).fill(0)),
  seqPlaying: false,
  seqStep: 0,
  seqNextTime: 0,
  seqStartTime: 0,
  seqTimerId: null,
  seqCells: [],
  drumMode: 'pads',
  seqAnchor: null,          // shared transport grid origin (drum seq + piano roll lock to this)

  // ── Piano-roll sequencer (polyphonic, 24 rows × 16 steps) ──
  synthMode: 'keys',        // keys | roll
  pseqPattern: Array.from({ length: 24 }, () => new Array(16).fill(0)),
  pseqPlaying: false,
  pseqStep: 0,
  pseqNextTime: 0,
  pseqStartTime: 0,
  pseqTimerId: null,
  pseqCells: [],

  // ── Quantize ──
  quantize: false,
};
