// ── Playback / audio-graph engine ─────────────────────────────────────────────
// Mirrors the studio per-track chain: src → offset → gain → mute → pan → EQ →
// master bus → (sub/air EQ → exciter → comp) → analyser → destination, with
// shared reverb + delay sends.
import { S, setStatus, currentPos } from './state.js';
import { createEq7 } from '../shared/eq7.js';

function _makeSatCurve(k){
  const n=256,c=new Float32Array(n);
  for(let i=0;i<n;i++){const x=(i*2/n)-1;c[i]=((Math.PI+k)*x)/(Math.PI+k*Math.abs(x));}
  return c;
}
function _makeIR(ctx,dur=2.5,decay=2.0){
  const len=Math.floor(ctx.sampleRate*dur);
  const buf=ctx.createBuffer(2,len,ctx.sampleRate);
  if(!S._reverbIRData){
    S._reverbIRData=[new Float32Array(len),new Float32Array(len)];
    for(let c=0;c<2;c++)for(let i=0;i<len;i++)
      S._reverbIRData[c][i]=(Math.random()*2-1)*Math.pow(1-i/len,decay);
  }
  for(let c=0;c<2;c++)buf.copyToChannel(S._reverbIRData[c],c);
  return buf;
}

export async function loadStems(stemUrls){
  S._actx=new AudioContext();
  const x=S._actx,m=S._mix;

  // ── Master bus ──
  const masterBus=x.createGain();
  masterBus.gain.value=m?.master?.volume??1;
  S._masterGain=masterBus;

  S._analyser=x.createAnalyser();
  S._analyser.fftSize=2048;
  S._analyser.connect(x.destination);

  // Build master chain: masterBus → [subEQ → airEQ → exciter] → [comp] → analyser
  let chainTail=masterBus;
  let reverbNode=null,delayInput=null;

  if(m){
    const subEQ=x.createBiquadFilter();subEQ.type='lowshelf';subEQ.frequency.value=60;subEQ.gain.value=m.master.subEQ||0;
    const airEQ=x.createBiquadFilter();airEQ.type='highshelf';airEQ.frequency.value=10000;airEQ.gain.value=m.master.airEQ||0;
    masterBus.connect(subEQ);subEQ.connect(airEQ);
    chainTail=airEQ;

    if(m.master.exciter){
      const hp=x.createBiquadFilter();hp.type='highpass';hp.frequency.value=3000;
      const sat=x.createWaveShaper();sat.curve=_makeSatCurve(200);sat.oversample='4x';
      const wet=x.createGain();wet.gain.value=0.18;
      airEQ.connect(hp);hp.connect(sat);sat.connect(wet);wet.connect(S._analyser);
    }
    if(m.master.comp){
      const comp=x.createDynamicsCompressor();
      comp.threshold.value=-18;comp.knee.value=12;comp.ratio.value=4;comp.attack.value=0.005;comp.release.value=0.15;
      chainTail.connect(comp);chainTail=comp;
    }

    // Reverb
    reverbNode=x.createConvolver();reverbNode.buffer=_makeIR(x);
    const revRtn=x.createGain();revRtn.gain.value=0.85;
    reverbNode.connect(revRtn);revRtn.connect(masterBus);

    // Delay
    delayInput=x.createGain();
    const dlyNode=x.createDelay(2.0);dlyNode.delayTime.value=0.35;
    const dlyFB=x.createGain();dlyFB.gain.value=0.38;
    const dlyRtn=x.createGain();dlyRtn.gain.value=0.8;
    delayInput.connect(dlyNode);dlyNode.connect(dlyFB);dlyFB.connect(dlyNode);
    dlyNode.connect(dlyRtn);dlyRtn.connect(masterBus);
  }

  chainTail.connect(S._analyser);

  // ── Recording tap (captures master output without affecting playback) ──
  S._recAudioDest = x.createMediaStreamDestination();
  S._analyser.connect(S._recAudioDest);

  // ── Load and wire each stem ──
  const names=Object.keys(stemUrls);
  for(let i=0;i<names.length;i++){
    const name=names[i];
    setStatus('Loading stems…',`${i+1} / ${names.length}: ${name}`);
    try{
      const ab=await(await fetch(stemUrls[name])).arrayBuffer();
      const buf=await S._actx.decodeAudioData(ab);
      const s=m?.stems?.[name];

      const gainNode=x.createGain();
      gainNode.gain.value=s?(s.muted?0:s.volume):1;

      if(s){
        // Full per-track graph matching the studio chain
        const muteNode=x.createGain();muteNode.gain.value=1;
        const offsetNode=x.createDelay(0.051);offsetNode.delayTime.value=s.offset||0;
        const panNode=x.createStereoPanner();panNode.pan.value=s.pan||0;
        // 7-band per-track EQ rebuilt from the Studio snapshot (flat if none saved)
        const eq=createEq7(x, (s.eq7&&s.eq7.length)?s.eq7:undefined);
        // src → offsetNode → gainNode → muteNode → panNode → EQ → masterBus
        offsetNode.connect(gainNode);gainNode.connect(muteNode);muteNode.connect(panNode);
        panNode.connect(eq.input);
        eq.output.connect(masterBus);
        if(reverbNode&&s.revAmt){const rs=x.createGain();rs.gain.value=s.revAmt;eq.output.connect(rs);rs.connect(reverbNode);}
        if(delayInput&&s.dlyAmt){const ds=x.createGain();ds.gain.value=s.dlyAmt;eq.output.connect(ds);ds.connect(delayInput);}
        S._stems[name]={buffer:buf,gainNode,muteNode,offsetNode,volume:s.muted?0:s.volume,muteRanges:s.muteRanges||[]};
      }else{
        gainNode.connect(masterBus);
        S._stems[name]={buffer:buf,gainNode};
      }

      if(!S._dur)S._dur=buf.duration;
      if(name==='vocals')S._vocalsGain=gainNode;
    }catch(e){console.warn('stem load failed:',name,e);}
  }
}

export function startPlayback(){
  if(!S._actx||!Object.keys(S._stems).length)return;
  if(S._actx.state==='suspended')S._actx.resume();
  S._startTime=S._actx.currentTime;
  const off=Math.max(0,Math.min(S._dur,S._startOff));
  const t0=S._actx.currentTime+0.05;
  for(const[name,t]of Object.entries(S._stems)){
    // Schedule mute region automation on muteNode (separate from gainNode volume)
    if(t.muteNode){
      t.muteNode.gain.cancelScheduledValues(0);
      t.muteNode.gain.value=1;
      for(const r of(t.muteRanges||[])){
        if(r.end<=off)continue;
        if(r.start<=off){t.muteNode.gain.setValueAtTime(0,t0);}
        else{t.muteNode.gain.setValueAtTime(0,t0+(r.start-off));}
        t.muteNode.gain.setValueAtTime(1,t0+Math.max(0,r.end-off));
      }
    }
    const src=S._actx.createBufferSource();
    src.buffer=t.buffer;
    src.connect(t.offsetNode||t.gainNode);
    src.start(t0,off);
    src.onended=()=>{if(S._sources[name]===src)S._sources[name]=null;};
    S._sources[name]=src;
  }
  S._playing=true;
  document.getElementById('play-btn').textContent='⏸';
}

export function stopSources(){
  for(const s of Object.values(S._sources)){try{s?.stop();}catch{}}
  S._sources={};
}

export function pausePlayback(){
  S._startOff=currentPos();
  stopSources();
  S._playing=false;
  document.getElementById('play-btn').textContent='▶';
}

export function togglePlay(){S._playing?pausePlayback():startPlayback();}

export function seekTo(pos){
  const was=S._playing;
  if(was)stopSources();
  S._startOff=Math.max(0,Math.min(S._dur,pos));
  S._startTime=S._actx?.currentTime||0;
  S._lastWordIdx=-1;
  if(was)startPlayback();
}

export function seekClick(e){
  const bar=document.getElementById('progress-bar');
  seekTo((e.offsetX/bar.clientWidth)*S._dur);
}

export function setVolume(v){
  if(S._masterGain&&S._actx)S._masterGain.gain.setTargetAtTime(parseFloat(v),S._actx.currentTime,0.02);
}

export function toggleVocals(){
  if(!S._vocalsGain||!S._actx)return;
  S._vocalsOn=!S._vocalsOn;
  const targetVol=S._vocalsOn?(S._stems['vocals']?.volume??1):0;
  S._vocalsGain.gain.setTargetAtTime(targetVol,S._actx.currentTime,0.05);
  const btn=document.getElementById('vocals-btn');
  btn.textContent=S._vocalsOn?'🎤 Vocals ON':'🎤 Vocals OFF';
  btn.classList.toggle('active',!S._vocalsOn);
}
