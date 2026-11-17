// ── Lyric-video recorder ─────────────────────────────────────────────────────
// Captures the canvas visualizer + audio as a WebM video file using
// MediaRecorder. The audio tap comes from S._recAudioDest (set up in
// audio-graph.js); the video comes from canvas.captureStream().
import { S } from './state.js';

// ── Codec negotiation ────────────────────────────────────────────────────────
function _pickMime(){
  // MP4 first: Chrome and Edge record H.264/AAC now, and Safari has for longer. WebM is
  // the fallback for browsers that still cannot, rather than the only option.
  const candidates=[
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for(const m of candidates)if(MediaRecorder.isTypeSupported(m))return m;
  return '';
}

// Name the file after what the recorder actually produced, never after what we asked
// for: MediaRecorder is allowed to fall back to another container.
function _extFor(mime){
  return /mp4/i.test(mime||'')?'mp4':'webm';
}

// ── Internal: assemble blob + trigger download ───────────────────────────────
function _finishRecording(){
  const mime=S._recorder?.mimeType||'video/webm';
  const blob=new Blob(S._recChunks,{type:mime});
  S._recChunks=[];
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  const title=(document.getElementById('title-bar')?.textContent||'karaoke').replace(/[^a-zA-Z0-9_\- ]/g,'').trim()||'karaoke';
  a.download=title+'_video.'+_extFor(mime);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function isRecording(){
  return S._recording;
}

// What the finished file will be, for the UI to say so before you press anything.
export function recordFormat(){
  return _extFor(_pickMime()).toUpperCase();
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
