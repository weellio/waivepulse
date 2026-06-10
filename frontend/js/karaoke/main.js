// ── main.js — bootstrap ───────────────────────────────────────────────────────
// Imports the modules, wires the controls auto-hide + RAF loop + keyboard, runs
// init(), and exposes every inline-handler function on window.
import { S, fmtTime, setStatus, hideStatus, currentPos } from './state.js';
import {
  loadStems, startPlayback, stopSources, pausePlayback,
  togglePlay, seekTo, seekClick, setVolume, toggleVocals,
} from './audio-graph.js';
import { padLyrics, updateLyrics } from './lyric-sync.js';
import { nextPreset, renderFrame } from './visualizers.js';
import { _updateResyncBtn, retranscribe, waitForTranscription } from './transcription.js';
import { startRecording, stopRecording, isRecording } from './recorder.js';

// ── Controls auto-hide ───────────────────────────────────────────────────────
document.addEventListener('mousemove',()=>{
  document.body.classList.add('show-cursor');
  document.getElementById('controls').classList.remove('hidden');
  document.getElementById('hint').style.opacity='1';
  clearTimeout(S._hideTimer);
  S._hideTimer=setTimeout(()=>{
    document.getElementById('controls').classList.add('hidden');
    document.getElementById('hint').style.opacity='0';
    document.body.classList.remove('show-cursor');
  },3500);
});

// ── RAF loop ─────────────────────────────────────────────────────────────────
function rafLoop(){
  requestAnimationFrame(rafLoop);
  if(!S._actx||!S._playing)return;
  const pos=currentPos();
  if(pos>=S._dur){if(isRecording())stopRecording();pausePlayback();return;}
  updateLyrics(pos);
  document.getElementById('progress-fill').style.width=(S._dur?pos/S._dur*100:0)+'%';
  document.getElementById('time-disp').textContent=fmtTime(pos)+' / '+fmtTime(S._dur);
}

// ── Keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  if(e.key===' '){e.preventDefault();togglePlay();}
  if(e.key==='Escape')goBack();
  if(e.key==='v'||e.key==='V')toggleVocals();
  if(e.key==='n'||e.key==='N')nextPreset();
  if(e.key==='r'||e.key==='R')toggleRecord();
  if(e.key==='ArrowLeft')seekTo(Math.max(0,currentPos()-5));
  if(e.key==='ArrowRight')seekTo(Math.min(S._dur,currentPos()+5));
});

function goBack(){
  const base='/studio?sep='+S._sepId;
  window.location.href=base;
}

function toggleRecord(){
  if(isRecording())stopRecording();
  else startRecording();
}

// ── Main init ────────────────────────────────────────────────────────────────
async function init(){
  if(!S._sepId){setStatus('Missing ?sep= parameter','Open Karaoke from the Studio page');return;}

  document.getElementById('back-btn').onclick=goBack;

  try{
    setStatus('Loading separation…');
    const sepRes=await fetch('/separate/status/'+S._sepId);
    if(!sepRes.ok)throw new Error('Separation not found ('+sepRes.status+')');
    const sep=await sepRes.json();
    if(sep.status!=='done')throw new Error('Separation not ready: '+sep.status);

    // Get title from job
    const jobId=sep.job_id;
    let title='WAIvePulse';
    if(jobId){
      const jr=await fetch('/status/'+jobId);
      if(jr.ok){const jd=await jr.json();title=jd.title||title;}
    }
    document.getElementById('title-bar').textContent=title;
    document.title='Karaoke — '+title;

    // Load audio
    await loadStems(sep.stems);

    // Check transcription
    const txd=await(await fetch('/transcribe/status/'+S._sepId)).json();
    if(txd.status==='done'){
      S._matchPct=txd.match_pct??null;
      S._words=padLyrics(txd.words||[]);
    }else if(txd.status==='transcribing'){
      setStatus('Transcribing lyrics…','This takes 30–60 seconds');
      await waitForTranscription();
    }else{
      // Check if whisper available; if so start it
      const ws=await(await fetch('/whisper-status')).json();
      if(ws.available){
        setStatus('Starting transcription…','Whisper will read the vocals stem');
        const tr=await fetch('/transcribe/'+S._sepId,{method:'POST'});
        if(tr.ok){await waitForTranscription();}
      }
      // No whisper — karaoke plays without timed lyrics
    }

    hideStatus();
    document.getElementById('controls').classList.remove('hidden');
    _updateResyncBtn();
    startPlayback();

  }catch(e){
    setStatus('Error loading karaoke',e.message);
    console.error(e);
  }
}

// ── Expose inline-handler functions on window ────────────────────────────────
Object.assign(window,{
  togglePlay, seekClick, setVolume, retranscribe, toggleVocals, nextPreset, goBack, toggleRecord,
});

// ── Bootstrap ────────────────────────────────────────────────────────────────
renderFrame();
rafLoop();
init();
