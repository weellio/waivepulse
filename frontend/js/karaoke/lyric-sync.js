// ── Lyric-sync engine ─────────────────────────────────────────────────────────
// Pads the word list head/tail, binary-searches the active word for a position,
// and renders the sliding 5-word window.
import { S } from './state.js';

export function padLyricHead(words){
  if(!words.length)return words;
  const first=words[0];
  const head=[];
  for(let i=3;i>=1;i--)head.push({word:'',start:Math.max(0,first.start-i*1.1),end:Math.max(0.1,first.start-i*1.1+0.5)});
  return [...head,...words];
}
export function padLyricTail(words){
  if(!words.length)return words;
  const last=words[words.length-1];
  const out=[...words];
  for(let i=1;i<=5;i++)out.push({word:'',start:last.end+i*1.1-0.5,end:last.end+i*1.1+0.5});
  return out;
}
export function padLyrics(words){return padLyricHead(padLyricTail(words));}

export function findWordIdx(pos){
  let lo=0,hi=S._words.length-1;
  while(lo<=hi){
    const mid=(lo+hi)>>1;
    if(S._words[mid].end<pos)lo=mid+1;
    else if(S._words[mid].start>pos)hi=mid-1;
    else return mid;
  }
  return Math.min(lo,S._words.length-1);
}

export function updateLyrics(pos){
  if(!S._words.length)return;
  const idx=findWordIdx(pos);
  if(idx===S._lastWordIdx)return;
  S._lastWordIdx=idx;
  const OPA=[0.22,0.55,1.0,0.55,0.22];
  for(let si=0;si<5;si++){
    const wi=idx-2+si;
    const el=document.getElementById('kw'+si);
    if(wi>=0&&wi<S._words.length){
      el.textContent=S._words[wi].word;
      el.style.opacity=OPA[si];
    }else{
      el.textContent='';
      el.style.opacity=0;
    }
  }
}
