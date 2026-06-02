// ── Constants ──────────────────────────────────────────────────────────────────
// Official HeartMuLa training categories (importance = how strongly it shapes output)
// Source: https://github.com/OneMonkeyArmy/heartlib/blob/main/TAGS_GUIDE.md
// One tag per category gives clearest results. Genre is required.
export const TAG_CATEGORIES = [
  { label: "Genre", importance: "required", open: true,
    desc: "primary style — pick one, always",
    tags: [
      "pop","rock","jazz","blues","hip-hop","electronic","classical","country","r&b",
      "metal","folk","reggae","soul","funk","ambient","lofi","indie","punk",
      "synthwave","gospel","latin","disco","new wave","bossa nova","opera",
      "k-pop","dance","edm","alternative","grunge","emo","trap","acoustic"
    ]
  },
  { label: "Timbre", importance: "recommended", open: false,
    desc: "tone quality / texture",
    tags: [
      "bright","dark","warm","cool","soft","harsh","crisp","mellow",
      "thin","thick","full","nasal","metallic","woody","smooth","gritty",
      "airy","rich","resonant","clean","distorted","raw"
    ]
  },
  { label: "Gender", importance: "recommended", open: false,
    desc: "vocalist gender",
    tags: [
      "male vocals","female vocals","mixed vocals","choir","no vocals","instrumental"
    ]
  },
  { label: "Mood", importance: "recommended", open: true,
    desc: "emotional tone",
    tags: [
      "happy","sad","energetic","calm","romantic","dark","upbeat","melancholic",
      "nostalgic","hopeful","angry","mysterious","triumphant","desperate",
      "tender","longing","bittersweet","playful","epic","haunting","peaceful","euphoric"
    ]
  },
  { label: "Instrument", importance: "recommended", open: false,
    desc: "featured instrument(s)",
    tags: [
      "piano","rhodes piano","electric piano","acoustic guitar","electric guitar",
      "bass guitar","drums","violin","cello","strings","synthesizer","synth pads",
      "trumpet","saxophone","flute","organ","banjo","ukulele","harp",
      "mandolin","808 bass","drum machine","brass","harpsichord"
    ]
  },
  { label: "Scene", importance: "optional", open: false,
    desc: "setting / context",
    tags: [
      "ballroom","nightclub","coffee shop","concert hall","street","beach",
      "rain","forest","stadium","bedroom","church","bar","wedding",
      "sunset","late night","morning","summer","winter","road trip","city"
    ]
  },
  { label: "Region", importance: "optional", open: false,
    desc: "cultural / geographic style",
    tags: [
      "american","british","japanese","korean","latin","african","european",
      "australian","nordic","celtic","mediterranean","caribbean","indian",
      "chinese","middle eastern","french","italian","spanish"
    ]
  },
  { label: "Topic", importance: "optional", open: false,
    desc: "lyrical subject matter",
    tags: [
      "love","heartbreak","friendship","freedom","nostalgia","youth","struggle",
      "faith","party","nature","urban life","family","loneliness","empowerment",
      "travel","loss","hope","identity","revenge","redemption"
    ]
  },
];

export const VIZ_CYCLE  = ['ring', 'bars', 'wave', 'galaxy', 'aurora', 'particles', 'scope'];
export const VIZ_LABELS = { ring: '◉ Ring', bars: '▐ Bars', wave: '∿ Wave', galaxy: '✦ Galaxy', aurora: '≋ Aurora', particles: '✺ Particles', scope: '⊙ Scope' };

export const TEMPLATES = {
  pop: `[Verse]\nChasing dreams in the city lights\nEverything is moving fast tonight\nI can feel the rhythm in my bones\nNever gonna make it on my own\n\n[Prechorus]\nBut when the music plays\nI forget my fears\n\n[Chorus]\nTurn it up, let it go\nFeel the beat from down below\nWe are alive, we are free\nThis is where we want to be\n\n[Verse]\nStrangers turn to friends by dawn\nThe night is short but we carry on\nEvery second counts tonight\nDancing till the morning light\n\n[Chorus]\nTurn it up, let it go\nFeel the beat from down below\nWe are alive, we are free\nThis is where we want to be\n\n[Outro]\nThis is where we want to be`,
  rock: `[Intro]\n\n[Verse]\nBroken glass on the floor again\nRunning hard through the pouring rain\nFed up with the way things are\nGonna drive this town in my old car\n\n[Prechorus]\nI won't back down, I won't give in\nThis is where my life begins\n\n[Chorus]\nWe are fire, we are stone\nWe will fight until we're home\nShout it out, make some noise\nThis is us, this is our voice\n\n[Bridge]\nThey tried to hold us down\nBut we rose up from the ground\nNothing gonna stop us now\n\n[Chorus]\nWe are fire, we are stone\nWe will fight until we're home\nShout it out, make some noise\nThis is us, this is our voice\n\n[Outro]\nThis is our voice`,
  ballad: `[Verse]\nYou left before the morning came\nA shadow where you used to lay\nI reach across the empty side\nAnd try to sleep but I just cry\n\n[Prechorus]\nI keep your memory near\nIn everything I do\n\n[Chorus]\nIf I could go back in time\nI'd hold you a little longer\nIf I could say one last goodbye\nMaybe I would be stronger\nBut all I have is yesterday\nAnd all these tears I cry\n\n[Verse]\nYour laughter echoes down the hall\nYour photo hanging on the wall\nI pour the coffee, set two cups\nThen remember, and give up\n\n[Chorus]\nIf I could go back in time\nI'd hold you a little longer\nIf I could say one last goodbye\nMaybe I would be stronger\n\n[Outro]\nMaybe I would be stronger`,
  hiphop: `[Intro]\nYeah, let me tell you something real\n\n[Verse]\nStarted with nothing, built this from the ground\nEvery single setback just made me more sound\nThey said I'd never make it, I proved them all wrong\nNow I'm writing chapters, I'm writing this song\nSix in the morning, I'm up on the grind\nDreams in my pocket, ambition in my mind\nNo shortcuts taken, this path is my own\nEvery brick I've laid, I built this throne\n\n[Chorus]\nRise up, never fall\nGot everything I need and nothing at all\nThis is my story, my name on the wall\nRise up, rise up, never fall\n\n[Verse]\nHandshakes and heartbreaks taught me the way\nTrust in the process, not just the pay\nLoyalty matters more than the crown\nI built my empire without burning the town\n\n[Chorus]\nRise up, never fall\nGot everything I need and nothing at all\nThis is my story, my name on the wall\nRise up, rise up, never fall\n\n[Outro]\nRise up`
};

// ── Shared mutable state ─────────────────────────────────────────────────────────
// Every variable that is written from more than one module lives on this single
// exported object. Mutating a property propagates across modules; reassigning an
// imported binding does NOT — so all shared state is held here.
export const S = {
  selectedTags: new Set(),
  activeJobs:   new Set(),
  openCards:    new Set(),
  jobSettings:  {},   // job_id → {lyrics, tags, title, maxDurationSec, temperature, cfgScale}
  jobLogLines:  {},   // job_id → string[]
  sseConns:     {},   // job_id → EventSource
  vizStyles:    {},
  vizFrames:    {},
  vizState:     {},   // job_id → { t, pts } for stateful viz
  audioNodes:   new WeakMap(),
  loadedLocalFiles: new Set(),  // "name|size" keys to prevent duplicate loads
  _localFileObjects: new Map(), // jobId → File, for Studio upload
  _actx: null,

  // Progress state
  _lmProgress:    {},   // job_id → 0-100
  _codecProgress: {},   // job_id → 0-100

  // Toast
  _toastTimer: null,

  // Fullscreen visualizer
  _fsJobId: null,
  _fsRafId: null,
  _fsStyle: 'ring',
  _fsState: {},
  _fsAudioEl: null,
};
