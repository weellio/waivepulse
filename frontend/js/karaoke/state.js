// ── Shared state ──────────────────────────────────────────────────────────────
// Every module-level mutable that is written from more than one module lives on
// this single exported object. Mutating S.x propagates across modules; never
// reassign the import binding itself.

// ── Params ───────────────────────────────────────────────────────────────────
const _params = new URLSearchParams(location.search);
const _sepId  = _params.get('sep');

// ── Mixer snapshot (read-only) ───────────────────────────────────────────────
const _mix = (() => { try { return JSON.parse(localStorage.getItem('waivepulse_mixer') || 'null'); } catch { return null; } })();

// ── Eye image (read-only handle, loads async) ────────────────────────────────
const _eyeImg = (() => { const i = new Image(); i.src = '/assets/eye.png'; return i; })();

// ── Preset table (read-only) ─────────────────────────────────────────────────
const PRESETS = [
  {name:'Galaxy',       engine:'galaxy'},
  {name:'Aurora',       engine:'aurora'},
  {name:'Bars',         engine:'bars'},
  {name:'Scope',        engine:'scope'},
  {name:'Hypertube',    engine:'starfield'},
  {name:'Kaleidoscope', engine:'kaleidoscope'},
  {name:'Neon Tunnel',  engine:'tunnel',  shape:'triangle'},
  {name:'Hex Portal',   engine:'tunnel',  shape:'hex'},
  {name:'Bubbles',      engine:'bubbles'},
  {name:'Lasers',       engine:'lasers'},
  {name:'Eye',          engine:'eye'},
  {name:'Mandala',      engine:'mandala'},
  {name:'Solar Pulse',  engine:'mask', shape:'star5',    pat:'dots',    hue:28,  accent:180,patSize:40,motion:'pulse'},
  {name:'Deep Ocean',   engine:'mask', shape:'hex',      pat:'rings',   hue:195, accent:40, patSize:56,motion:'breathe'},
  {name:'Amethyst',     engine:'mask', shape:'flower',   pat:'grid',    hue:280, accent:60, patSize:44,motion:'spin'},
  {name:'Acid Rain',    engine:'mask', shape:'cross',    pat:'lines',   hue:120, accent:300,patSize:40,motion:'pulse'},
  {name:'Midnight',     engine:'mask', shape:'diamond',  pat:'hex',     hue:220, accent:30, patSize:52,motion:'breathe'},
  {name:'Inferno',      engine:'mask', shape:'star8',    pat:'chevron', hue:0,   accent:50, patSize:40,motion:'spin'},
  {name:'Arctic',       engine:'mask', shape:'triangle', pat:'dots',    hue:180, accent:280,patSize:36,motion:'pulse'},
  {name:'Gold Rush',    engine:'mask', shape:'star6',    pat:'grid',    hue:45,  accent:200,patSize:48,motion:'breathe'},
  {name:'Void',         engine:'mask', shape:'circle',   pat:'rings',   hue:260, accent:100,patSize:52,motion:'spin'},
  {name:'Plasma',       engine:'mask', shape:'flower',   pat:'chevron', hue:320, accent:170,patSize:44,motion:'pulse'},
  {name:'Forest',       engine:'mask', shape:'hex',      pat:'lines',   hue:100, accent:280,patSize:48,motion:'breathe'},
  {name:'Chrome',       engine:'mask', shape:'star5',    pat:'hex',     hue:-1,  accent:60, patSize:48,motion:'spin'},
];

export const S = {
  // params / read-only-ish handles
  _params, _sepId, _mix, _eyeImg, PRESETS,

  // audio engine
  _actx: null, _playing: false, _dur: 0,
  _startTime: 0, _startOff: 0,
  _stems: {}, _sources: {}, _vocalsGain: null, _masterGain: null, _analyser: null, _vocalsOn: true,
  _reverbIRData: null,

  // lyrics
  _words: [], _lastWordIdx: -1, _matchPct: null,

  // visualizer
  _presetIdx: 0, _vizPhase: 0, _hideTimer: null,
  _maskRot: 0, _patRot: 0, _bassSmooth: 0, _midsSmooth: 0, _hiSmooth: 0,
  _beatFlash: 0, _beatAvg: 0, _patCache: {},
  _stars: null, _bubbles: null, _lasers: null,

  // canvas (set up by visualizer module)
  canvas: null, ctx: null,
};

// ── Helpers ──────────────────────────────────────────────────────────────────
export function fmtTime(s){const m=Math.floor(s/60);return m+':'+((''+Math.floor(s%60)).padStart(2,'0'));}
export function setStatus(msg,sub=''){document.getElementById('status-msg').textContent=msg;document.getElementById('status-sub').textContent=sub;}
export function hideStatus(){document.getElementById('status').classList.add('hidden');}
export function currentPos(){return S._playing?S._startOff+(S._actx.currentTime-S._startTime):S._startOff;}
