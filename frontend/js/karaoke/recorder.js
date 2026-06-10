// ── Lyric-video recorder ─────────────────────────────────────────────────────
// Captures the canvas visualizer + audio as a WebM video file using
// MediaRecorder. The audio tap comes from S._recAudioDest (set up in
// audio-graph.js); the video comes from canvas.captureStream().
import { S } from './state.js';

// ── Codec negotiation ────────────────────────────────────────────────────────
function _pickMime(){
  const candidates=[
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for(const m of candidates)if(MediaRecorder.isTypeSupported(m))return m;
  return '';
}

// ── Internal: assemble blob + trigger download ───────────────────────────────
function _finishRecording(){
  const blob=new Blob(S._recChunks,{type:S._recorder?.mimeType||'video/webm'});
  S._recChunks=[];
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  const title=(document.getElementById('title-bar')?.textContent||'karaoke').replace(/[^a-zA-Z0-9_\- ]/g,'').trim()||'karaoke';
  a.download=title+'_video.webm';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isRecording(){
  return S._recording;
}

export function startRecording(){
  if(S._recording)return;
  if(!S.canvas||!S._recAudioDest){console.warn('recorder: canvas or audio dest not ready');return;}

  // Canvas video stream at 30 fps
  const canvasStream=S.canvas.captureStream(30);

  // Audio stream from the master-output tap
  const audioStream=S._recAudioDest.stream;

  // Combine video + audio into one MediaStream
  const combined=new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audioStream.getAudioTracks(),
  ]);

  const mimeType=_pickMime();
  const opts=mimeType?{mimeType}:{};
  S._recorder=new MediaRecorder(combined,opts);
  S._recChunks=[];

  S._recorder.ondataavailable=e=>{if(e.data&&e.data.size>0)S._recChunks.push(e.data);};
  S._recorder.onstop=()=>{
    S._recording=false;
    _finishRecording();
    _updateUI(false);
  };

  S._recorder.start(1000);
  S._recording=true;
  _updateUI(true);
}

export function stopRecording(){
  if(!S._recording||!S._recorder)return;
  S._recorder.stop();
  // onstop handler sets _recording=false and triggers download
}

// ── UI helpers ───────────────────────────────────────────────────────────────
function _updateUI(active){
  const btn=document.getElementById('rec-btn');
  const dot=document.getElementById('rec-indicator');
  if(btn){
    btn.classList.toggle('active',active);
    btn.classList.toggle('rec-active',active);
    btn.textContent=active?'\u23F9 Stop':'\u23FA Record';
  }
  if(dot)dot.style.display=active?'flex':'none';
}
