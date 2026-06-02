// ── Transcription polling + re-sync ───────────────────────────────────────────
import { S, setStatus } from './state.js';
import { padLyrics } from './lyric-sync.js';

export function _updateResyncBtn(){
  const btn=document.getElementById('resync-btn');
  if(!btn)return;
  btn.style.display=S._words.length?'':'none';
  if(S._matchPct===null){btn.textContent='🔄 Re-sync';return;}
  const ok=S._matchPct>=90;
  btn.textContent=`🔄 ${S._matchPct}%`;
  btn.style.color=ok?'':'#ff7c7c';
  btn.style.borderColor=ok?'':'#7c2020';
  btn.title=ok
    ?`Lyrics matched ${S._matchPct}% — click to re-run with a larger model`
    :`Only ${S._matchPct}% of lyrics matched — click Re-sync for better accuracy`;
}

export async function retranscribe(){
  const btn=document.getElementById('resync-btn');
  btn.textContent='⏳ Syncing…';btn.disabled=true;
  // Pick a better model than whatever was used before
  const model=S._matchPct!==null&&S._matchPct<85?'small':'small';
  try{
    const r=await fetch(`/transcribe/${S._sepId}?force=true&model=${model}`,{method:'POST'});
    if(!r.ok)throw new Error(await r.text());
    // Poll until done
    for(;;){
      await new Promise(res=>setTimeout(res,2500));
      const d=await(await fetch('/transcribe/status/'+S._sepId)).json();
      if(d.status==='done'){
        S._matchPct=d.match_pct??null;
        S._words=padLyrics(d.words||[]);
        S._lastWordIdx=-1;
        _updateResyncBtn();
        break;
      }
      if(d.status==='error'){btn.textContent='❌ Failed';btn.disabled=false;return;}
    }
  }catch(e){console.error(e);btn.textContent='❌ Error';}
  btn.disabled=false;
}

export async function waitForTranscription(){
  for(;;){
    const d=await(await fetch('/transcribe/status/'+S._sepId)).json();
    if(d.status==='done'){S._matchPct=d.match_pct??null;S._words=padLyrics(d.words||[]);return;}
    if(d.status==='error'){console.warn('Transcription failed:',d.message);return;}
    setStatus('Transcribing lyrics…','This takes 30–60 seconds — Whisper is reading the vocals stem');
    await new Promise(r=>setTimeout(r,2500));
  }
}
