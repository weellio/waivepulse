// ── Transcription polling + re-sync ───────────────────────────────────────────
import { S, setStatus } from './state.js';
import { padLyrics } from './lyric-sync.js';

// Transcription runs on the CPU, so the large models are not worth their wait here.
const LADDER=['tiny','base','small','medium'];

export function nextModel(used){
  const i=LADDER.indexOf(used);
  if(i<0)return 'small';                    // nothing recorded — start where we always did
  return LADDER[Math.min(i+1,LADDER.length-1)];
}

export function atTopModel(){
  return S._txModel===LADDER[LADDER.length-1];
}

export function _updateResyncBtn(){
  const btn=document.getElementById('resync-btn');
  if(!btn)return;
  btn.style.display=S._words.length?'':'none';
  // Say what the next press will actually do, rather than promising it will be better.
  const nxt=atTopModel()
    ?`Already read with the largest model this runs on the CPU (${S._txModel})`
    :`Click to read the vocals again with the ${nextModel(S._txModel)} model`;
  if(S._matchPct===null){
    btn.textContent='🔄 Re-sync';
    btn.title=(S._txModel?`Read with the ${S._txModel} model. `:'')+nxt;
    return;
  }
  const ok=S._matchPct>=90;
  btn.textContent=`🔄 ${S._matchPct}%`;
  btn.style.color=ok?'':'#ff7c7c';
  btn.style.borderColor=ok?'':'#7c2020';
  btn.title=`${S._matchPct}% of the lyrics matched. ${nxt}`;
}

export async function retranscribe(){
  const btn=document.getElementById('resync-btn');
  btn.textContent='⏳ Syncing…';btn.disabled=true;
  // One rung up from whatever produced the words we are holding.
  const model=nextModel(S._txModel);
  btn.title=`Reading the vocals again with the ${model} model…`;
  try{
    const r=await fetch(`/transcribe/${S._sepId}?force=true&model=${model}`,{method:'POST'});
    if(!r.ok)throw new Error(await r.text());
    // Poll until done
    for(;;){
      await new Promise(res=>setTimeout(res,2500));
      const d=await(await fetch('/transcribe/status/'+S._sepId)).json();
      if(d.status==='done'){
        S._matchPct=d.match_pct??null;
        S._txModel=d.tx_model??model;
        S._words=padLyrics(d.words||[]);
        S._lastWordIdx=-1;
        _updateResyncBtn();
        window.dispatchEvent(new Event('karaoke-words'));
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
    if(d.status==='done'){S._matchPct=d.match_pct??null;S._txModel=d.tx_model??null;S._words=padLyrics(d.words||[]);return;}
    if(d.status==='error'){console.warn('Transcription failed:',d.message);return;}
    setStatus('Transcribing lyrics…','This takes 30–60 seconds — Whisper is reading the vocals stem');
    await new Promise(r=>setTimeout(r,2500));
  }
}
