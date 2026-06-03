// Shared mutable studio state.
//
// ES modules cannot share reassignable `let` bindings across files, so every
// variable that is written from more than one module lives as a PROPERTY of
// this single exported object. Modules import `S` and read/write `S.x`;
// mutating a property propagates everywhere because all modules reference the
// same object. NEVER `import` a primitive and reassign it expecting other
// modules to see the change — put it on S instead.

export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
export const STEM_COLORS = {
  vocals: '#4ae8d4', drums: '#e87c4a', bass: '#4a9ee8',
  guitar: '#5cbe6a', piano: '#e8cc4a', other: '#888888',
};
export const PEAK_BINS = 2400;
export const IMPORT_COLOR = '#e8c84a';

export const PRESETS = {
  full: {},
  karaoke: { vocals: true },
  acappella: { drums: true, bass: true, guitar: true, piano: true, other: true },
  drumsonly: { vocals: true, bass: true, guitar: true, piano: true, other: true },
  nodrums: { drums: true },
};

export const S = {
  // ── Job / song ──
  _jobId: null, _sepId: null, _title: '', _dur: 0,

  // ── Audio context / transport ──
  _actx: null, _playing: false, _looping: false,
  _startTime: 0, _startOff: 0, _rafId: null, _sseConn: null,
  _zoom: 1,
  _fadeGain: null, _fadeIn: 0, _fadeOut: 0,   // master fade in/out (seconds)
  _cutUndo: null,                              // ripple-cut undo stack

  // ── Loop / drag / preset / selection ──
  _loopStart: null, _loopEnd: null, _rulerDrag: null, _activePreset: 'full',
  _rangeDrawing: null,
  _importCounter: 0,
  _dragDepth: 0,
  _selectedTrack: null,
  _trackPosDrag: null,

  // ── Master chain: existing effects ──
  _masterBus: null, _masterComp: null, _compDryGain: null, _compWetGain: null,
  _compEnabled: false,
  _masterClip: null, _clipWetGain: null, _clipEnabled: false,
  _masterSubEQ: null, _masterAirEQ: null,
  _exciterHP: null, _exciterSat: null, _exciterWet: null, _exciterEnabled: false,

  // ── Master chain: post-EQ serial FX node the effects split off from ──
  // _masterAirEQ -> _gate -> _crusher -> _folderXfade -> _fxOut -> (comp/clip/exciter/reverb-send)
  _fxOut: null,

  // ── New effect: noise gate (worklet, bypassable via dry/wet) ──
  _gateNode: null, _gateInput: null, _gateDryGain: null, _gateWetGain: null, _gateEnabled: false,

  // ── New effect: bitcrusher (worklet, bypassable via dry/wet) ──
  _crusherNode: null, _crusherInput: null, _crusherDryGain: null, _crusherWetGain: null, _crusherEnabled: false,

  // ── New effect: wavefolder (WaveShaper 4x, bypassable via dry/wet) ──
  _folderInput: null, _folderShaper: null, _folderPreGain: null,
  _folderDryGain: null, _folderWetGain: null, _folderEnabled: false, _folderDrive: 2,

  // ── New effect: Dattorro plate reverb (worklet, parallel master send) ──
  _plateNode: null, _plateSend: null, _plateReturn: null, _plateEnabled: false, _plateMix: 0.3,

  // ── Reverb / delay sends (existing) ──
  _reverbNode: null, _reverbReturn: null, _reverbIRData: null,
  _delayInput: null, _delayNode: null, _delayFeedback: null, _delayReturn: null,

  // ── Worklet availability ──
  _workletsReady: false,

  // ── Tracks ──
  tracks: {},

  // ── Visual EQ ──
  _eqState: null,

  // ── Karaoke ──
  _autoTranscribe: localStorage.getItem('waivepulse_autotx') === '1',
};
