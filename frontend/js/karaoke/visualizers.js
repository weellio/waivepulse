// ── Visualizers ───────────────────────────────────────────────────────────────
// Canvas setup, audio-level analysis, all 20+ draw engines, preset cycling and
// the main render loop. Engines read smoothed audio levels + beat state off S.
import { S } from './state.js';

// ── Canvas ───────────────────────────────────────────────────────────────────
const canvas=document.getElementById('viz');
const ctx=canvas.getContext('2d');
S.canvas=canvas;
S.ctx=ctx;

export function resizeCanvas(){canvas.width=window.innerWidth;canvas.height=window.innerHeight;}
window.addEventListener('resize',()=>{resizeCanvas();S._stars=null;S._lasers=null;});
resizeCanvas();

export function nextPreset(){
  S._presetIdx=(S._presetIdx+1)%S.PRESETS.length;
  S._patCache={};S._stars=null;S._bubbles=null;S._lasers=null;
  const el=document.getElementById('preset-name');
  el.textContent=S.PRESETS[S._presetIdx].name;
  el.style.opacity='1';
  setTimeout(()=>el.style.opacity='0',1800);
}

// ── Audio helpers ─────────────────────────────────────────────────────────────
function getAudioLevels(freq){
  const n=freq.length;
  const be=Math.max(1,Math.floor(n*.03));
  const me=Math.max(be+1,Math.floor(n*.15));
  const he=Math.max(me+1,Math.floor(n*.4));
  let bass=0,mids=0,hi=0;
  for(let i=0;i<be;i++)bass+=freq[i]/255;
  for(let i=be;i<me;i++)mids+=freq[i]/255;
  for(let i=me;i<he;i++)hi+=freq[i]/255;
  bass/=be; mids/=(me-be); hi/=(he-me);
  return{bass,mids,hi,energy:(bass*2+mids+hi)/4};
}

// ── Starfield / Hypertube ─────────────────────────────────────────────────────
function newStar(W,H,spread){
  const a=Math.random()*Math.PI*2;
  const r=Math.pow(Math.random(),0.5)*0.75;
  return{x:Math.cos(a)*r,y:Math.sin(a)*r,z:spread?Math.random():1,pz:null,
    hue:Math.random()*360,speed:0.7+Math.random()*0.6};
}
function drawStarfield(W,H,freq){
  if(!S._stars){S._stars=[];for(let i=0;i<350;i++)S._stars.push(newStar(W,H,true));}
  const focal=Math.min(W,H)*0.55,cx=W/2,cy=H/2;
  const spd=0.006+S._bassSmooth*0.055;
  for(let i=0;i<S._stars.length;i++){
    const s=S._stars[i];
    s.pz=s.z; s.z-=spd*s.speed;
    if(s.z<=0.001){S._stars[i]=newStar(W,H,false);continue;}
    const sx=cx+(s.x/s.z)*focal, sy=cy+(s.y/s.z)*focal;
    const px=cx+(s.x/s.pz)*focal,py=cy+(s.y/s.pz)*focal;
    if(sx<-20||sx>W+20||sy<-20||sy>H+20){S._stars[i]=newStar(W,H,false);continue;}
    const bright=Math.pow(1-s.z,1.5);
    s.hue=(s.hue+0.4)%360;
    ctx.strokeStyle=`hsla(${s.hue},80%,${55+bright*40}%,${0.35+bright*0.65})`;
    ctx.lineWidth=Math.max(0.5,(1-s.z)*2.5+S._bassSmooth*1.5);
    ctx.beginPath();ctx.moveTo(px,py);ctx.lineTo(sx,sy);ctx.stroke();
  }
  const rimR=Math.min(W,H)*0.38;
  const rim=ctx.createRadialGradient(cx,cy,rimR*.7,cx,cy,rimR*1.15);
  rim.addColorStop(0,'transparent');
  rim.addColorStop(0.7,`hsla(${(S._vizPhase*15)%360},100%,50%,${0.04+S._bassSmooth*0.08})`);
  rim.addColorStop(1,'transparent');
  ctx.fillStyle=rim;ctx.fillRect(0,0,W,H);
}

// ── Kaleidoscope ──────────────────────────────────────────────────────────────
function drawKaleidoscopeWedge(freq,wedgeAngle,maxR){
  const nBars=38;
  for(let i=0;i<nBars;i++){
    const t=i/nBars;
    const a=t*wedgeAngle;
    const amp=freq[Math.floor(t*freq.length*0.55)]/255;
    const r0=maxR*0.08, r1=r0+amp*maxR*0.92;
    const hue=(t*210+S._vizPhase*55)%360;
    ctx.strokeStyle=`hsla(${hue},100%,${52+amp*32}%,${0.45+amp*0.55})`;
    ctx.lineWidth=1.2+amp*2.8;
    ctx.shadowColor=`hsla(${hue},100%,72%,0.7)`;ctx.shadowBlur=2+amp*9;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a)*r0,Math.sin(a)*r0);
    ctx.lineTo(Math.cos(a)*r1,Math.sin(a)*r1);
    ctx.stroke();
  }
  for(let ri=0;ri<4;ri++){
    const rAmp=freq[10+ri*15]/255;
    const arcR=maxR*(0.18+ri*0.22+rAmp*0.06);
    ctx.strokeStyle=`hsla(${(S._vizPhase*30+ri*50)%360},100%,70%,${0.14+rAmp*0.35})`;
    ctx.lineWidth=0.8+rAmp*1.5;
    ctx.beginPath();ctx.arc(0,0,arcR,0,wedgeAngle);ctx.stroke();
  }
  if(S._beatFlash>0.15){
    for(let i=0;i<6;i++){
      const a=Math.random()*wedgeAngle, r=maxR*(0.1+Math.random()*0.85);
      ctx.fillStyle=`rgba(255,255,255,${S._beatFlash*0.9})`;
      ctx.beginPath();ctx.arc(Math.cos(a)*r,Math.sin(a)*r,1+S._beatFlash*3,0,Math.PI*2);ctx.fill();
    }
  }
  ctx.shadowBlur=0;
}
function drawKaleidoscope(W,H,freq){
  const cx=W/2,cy=H/2,N=12,wedge=Math.PI*2/N;
  const maxR=Math.min(W,H)*0.46;
  for(let s=0;s<N;s++){
    ctx.save();ctx.translate(cx,cy);
    ctx.rotate(s*wedge+S._vizPhase*0.18);
    if(s%2===1)ctx.scale(1,-1);
    ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,maxR+10,0,wedge);ctx.closePath();ctx.clip();
    drawKaleidoscopeWedge(freq,wedge,maxR);
    ctx.restore();
  }
}

// ── Shape helper (shared by Tunnel + Mask) ────────────────────────────────────
function buildShapePath(c,shape,r){
  c.beginPath();
  if(shape==='flower'){
    for(let i=0;i<6;i++){
      const a=i/6*Math.PI*2,px=Math.cos(a)*r*.5,py=Math.sin(a)*r*.5;
      c.moveTo(px+r*.45,py);c.arc(px,py,r*.45,0,Math.PI*2);
    }
    return;
  }
  if(shape==='circle'){c.arc(0,0,r,0,Math.PI*2);c.closePath();return;}
  if(shape==='star5'||shape==='star6'||shape==='star8'){
    const pts=shape==='star5'?5:shape==='star6'?6:8, inner=r*(shape==='star8'?.44:.40);
    for(let i=0;i<pts*2;i++){
      const a=i/(pts*2)*Math.PI*2-Math.PI/2,rr=i%2===0?r:inner;
      i===0?c.moveTo(Math.cos(a)*rr,Math.sin(a)*rr):c.lineTo(Math.cos(a)*rr,Math.sin(a)*rr);
    }
  }else if(shape==='hex'){
    for(let i=0;i<6;i++){const a=i/6*Math.PI*2;i===0?c.moveTo(Math.cos(a)*r,Math.sin(a)*r):c.lineTo(Math.cos(a)*r,Math.sin(a)*r);}
  }else if(shape==='diamond'){
    c.moveTo(0,-r);c.lineTo(r*.6,0);c.lineTo(0,r);c.lineTo(-r*.6,0);
  }else if(shape==='cross'){
    const a=r*.35;
    c.moveTo(-a,-r);c.lineTo(a,-r);c.lineTo(a,-a);c.lineTo(r,-a);
    c.lineTo(r,a);c.lineTo(a,a);c.lineTo(a,r);c.lineTo(-a,r);
    c.lineTo(-a,a);c.lineTo(-r,a);c.lineTo(-r,-a);c.lineTo(-a,-a);
  }else if(shape==='triangle'){
    for(let i=0;i<3;i++){const a=i/3*Math.PI*2-Math.PI/2;i===0?c.moveTo(Math.cos(a)*r,Math.sin(a)*r):c.lineTo(Math.cos(a)*r,Math.sin(a)*r);}
  }
  c.closePath();
}

// ── Neon Tunnel ───────────────────────────────────────────────────────────────
function drawTunnel(W,H,freq,shape){
  const cx=W/2,cy=H/2,steps=52;
  const baseR=Math.min(W,H)*0.52, zoom=1+S._beatFlash*0.18;
  ctx.save();ctx.translate(cx,cy);
  for(let i=steps;i>=0;i--){
    const t=i/steps, r=baseR*Math.pow(0.92,steps-i)*zoom;
    if(r<3)continue;
    const amp=freq[Math.floor(t*freq.length*0.5)]/255;
    const hue=(t*280+S._vizPhase*25)%360;
    ctx.save();ctx.rotate(S._vizPhase*0.45+i*0.055);
    buildShapePath(ctx,shape,r);
    ctx.strokeStyle=`hsla(${hue},100%,${48+amp*32}%,${0.25+amp*0.75})`;
    ctx.lineWidth=0.8+amp*2.2;
    ctx.shadowColor=`hsla(${hue},100%,70%,.55)`;ctx.shadowBlur=3+amp*10;
    ctx.stroke();ctx.shadowBlur=0;ctx.restore();
  }
  ctx.restore();
  const vg=ctx.createRadialGradient(cx,cy,0,cx,cy,baseR*0.3);
  vg.addColorStop(0,`hsla(${(S._vizPhase*20)%360},100%,90%,${0.5+S._bassSmooth*0.5})`);
  vg.addColorStop(1,'transparent');
  ctx.fillStyle=vg;ctx.fillRect(0,0,W,H);
}

// ── Bubbles ───────────────────────────────────────────────────────────────────
function newBubble(W,H,randomY){
  return{x:30+Math.random()*(W-60),y:randomY?Math.random()*H:H+60,
    vx:(Math.random()-0.5)*0.9,vy:-(0.4+Math.random()*1.2),
    r:18+Math.random()*55,hue:Math.random()*360,alpha:0.35+Math.random()*0.35,
    popping:false,popT:0,particles:null};
}
function popParticles(b){
  return Array.from({length:9},(_,i)=>{
    const a=i/9*Math.PI*2+(Math.random()-.5)*.4;
    return{x:b.x,y:b.y,vx:Math.cos(a)*(2+Math.random()*4),vy:Math.sin(a)*(2+Math.random()*4),r:2+Math.random()*4,life:1};
  });
}
function drawBubbles(W,H,freq){
  if(!S._bubbles){S._bubbles=[];for(let i=0;i<22;i++)S._bubbles.push(newBubble(W,H,true));}
  if(S._bubbles.length<28&&Math.random()<0.04)S._bubbles.push(newBubble(W,H,false));
  if(S._beatFlash>0.75){
    const n=1+Math.floor(S._beatFlash*2);
    for(let k=0;k<n;k++){
      const live=S._bubbles.filter(b=>!b.popping);
      if(live.length){const b=live[Math.floor(Math.random()*live.length)];b.popping=true;b.particles=popParticles(b);}
    }
  }
  for(let i=S._bubbles.length-1;i>=0;i--){
    const b=S._bubbles[i];
    if(b.popping){
      b.popT+=0.07;
      ctx.strokeStyle=`hsla(${b.hue},100%,75%,${1-b.popT})`;ctx.lineWidth=2;
      ctx.shadowColor=`hsla(${b.hue},100%,75%,0.6)`;ctx.shadowBlur=10;
      ctx.beginPath();ctx.arc(b.x,b.y,b.r+b.popT*50,0,Math.PI*2);ctx.stroke();
      ctx.shadowBlur=0;
      if(b.particles)for(const p of b.particles){
        p.x+=p.vx;p.y+=p.vy;p.vy+=0.08;p.life-=0.04;
        if(p.life>0){ctx.fillStyle=`hsla(${b.hue},100%,78%,${p.life})`;ctx.beginPath();ctx.arc(p.x,p.y,p.r*p.life,0,Math.PI*2);ctx.fill();}
      }
      if(b.popT>=1)S._bubbles.splice(i,1);
      continue;
    }
    b.x+=b.vx+Math.sin(S._vizPhase*0.7+i*0.8)*0.4;b.y+=b.vy;
    b.hue=(b.hue+0.25)%360;
    if(b.y+b.r<-80){S._bubbles.splice(i,1);continue;}
    const g=ctx.createRadialGradient(b.x-b.r*.3,b.y-b.r*.3,b.r*.05,b.x,b.y,b.r);
    g.addColorStop(0,`hsla(${b.hue},50%,96%,${b.alpha*.85})`);
    g.addColorStop(0.45,`hsla(${b.hue},75%,62%,${b.alpha*.28})`);
    g.addColorStop(1,`hsla(${b.hue},100%,38%,${b.alpha*.65})`);
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=`rgba(255,255,255,${b.alpha*.45})`;
    ctx.beginPath();ctx.ellipse(b.x-b.r*.28,b.y-b.r*.32,b.r*.22,b.r*.13,-Math.PI/5,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=`hsla(${b.hue},100%,80%,${b.alpha*.5})`;ctx.lineWidth=1.2;
    ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.stroke();
  }
}

// ── Lasers ────────────────────────────────────────────────────────────────────
function newLaser(W,H){
  const edge=Math.floor(Math.random()*4);
  const x=edge===1?W:edge===3?0:Math.random()*W;
  const y=edge===0?0:edge===2?H:Math.random()*H;
  const ang=Math.random()*Math.PI*2;
  return{x,y,vx:Math.cos(ang),vy:Math.sin(ang),hue:Math.random()*360,trail:[{x,y}]};
}
function drawLasers(W,H,freq){
  if(!S._lasers){S._lasers=[];for(let i=0;i<7;i++)S._lasers.push(newLaser(W,H));}
  const spd=4+S._bassSmooth*9, trailLen=18+Math.floor(S._hiSmooth*12);
  for(const L of S._lasers){
    L.x+=L.vx*spd;L.y+=L.vy*spd;
    if(L.x<=0||L.x>=W){L.vx*=-1;L.x=Math.max(0,Math.min(W,L.x));}
    if(L.y<=0||L.y>=H){L.vy*=-1;L.y=Math.max(0,Math.min(H,L.y));}
    L.hue=(L.hue+0.6+S._midsSmooth*3)%360;
    L.trail.push({x:L.x,y:L.y});
    if(L.trail.length>trailLen)L.trail.shift();
    if(L.trail.length<2)continue;
    for(let i=1;i<L.trail.length;i++){
      const t=i/L.trail.length;
      ctx.strokeStyle=`hsla(${L.hue},100%,70%,${t*(0.5+S._hiSmooth*0.5)})`;
      ctx.lineWidth=t*(2+S._bassSmooth*4);
      ctx.shadowColor=`hsla(${L.hue},100%,70%,0.8)`;ctx.shadowBlur=4+t*16;
      ctx.beginPath();ctx.moveTo(L.trail[i-1].x,L.trail[i-1].y);ctx.lineTo(L.trail[i].x,L.trail[i].y);ctx.stroke();
    }
    ctx.shadowBlur=0;
  }
  if(S._beatFlash>0.25){
    for(let i=0;i<S._lasers.length;i++)for(let j=i+1;j<S._lasers.length;j++){
      const d=Math.hypot(S._lasers[i].x-S._lasers[j].x,S._lasers[i].y-S._lasers[j].y);
      if(d<Math.min(W,H)*0.45){
        const h=(S._lasers[i].hue+S._lasers[j].hue)/2;
        ctx.strokeStyle=`hsla(${h},100%,85%,${S._beatFlash*(1-d/(Math.min(W,H)*.45))*.5})`;
        ctx.lineWidth=1;ctx.shadowColor=`hsla(${h},100%,80%,.6)`;ctx.shadowBlur=8;
        ctx.beginPath();ctx.moveTo(S._lasers[i].x,S._lasers[i].y);ctx.lineTo(S._lasers[j].x,S._lasers[j].y);ctx.stroke();
        ctx.shadowBlur=0;
      }
    }
  }
}

// ── Eye Radial ────────────────────────────────────────────────────────────────
function drawEye(W,H,freq){
  const cx=W/2,cy=H/2;
  const eyeR=Math.min(W,H)*0.20;
  const barR0=eyeR+6, barMax=Math.min(W,H)*0.32;
  for(let i=0;i<256;i++){
    const amp=freq[Math.floor(i*freq.length/256)]/255;
    const angle=(i/256)*Math.PI*2-Math.PI/2+S._vizPhase*0.08;
    const barLen=amp*barMax;
    if(barLen<2)continue;
    const hue=(i/256*360+S._vizPhase*18)%360;
    const x0=cx+Math.cos(angle)*barR0, y0=cy+Math.sin(angle)*barR0;
    const x1=cx+Math.cos(angle)*(barR0+barLen), y1=cy+Math.sin(angle)*(barR0+barLen);
    const lg=ctx.createLinearGradient(x0,y0,x1,y1);
    lg.addColorStop(0,`hsla(${hue},100%,65%,${0.5+amp*0.5})`);
    lg.addColorStop(1,`hsla(${(hue+60)%360},100%,80%,0)`);
    ctx.strokeStyle=lg;ctx.lineWidth=1.2+amp*3;
    ctx.shadowColor=`hsla(${hue},100%,70%,.5)`;ctx.shadowBlur=4+amp*14;
    ctx.beginPath();ctx.moveTo(x0,y0);ctx.lineTo(x1,y1);ctx.stroke();
  }
  ctx.shadowBlur=0;
  ctx.save();
  ctx.beginPath();ctx.arc(cx,cy,eyeR,0,Math.PI*2);ctx.clip();
  if(S._eyeImg.complete&&S._eyeImg.naturalWidth){
    const ar=S._eyeImg.naturalWidth/S._eyeImg.naturalHeight;
    const dh=eyeR*2, dw=dh*ar;
    ctx.drawImage(S._eyeImg,cx-dw/2,cy-dh/2,dw,dh);
  }else{
    const og=ctx.createRadialGradient(cx,cy,0,cx,cy,eyeR);
    og.addColorStop(0,`hsla(${(S._vizPhase*20)%360},100%,85%,.9)`);
    og.addColorStop(1,`hsla(${(S._vizPhase*20+120)%360},100%,35%,.4)`);
    ctx.fillStyle=og;ctx.fillRect(cx-eyeR,cy-eyeR,eyeR*2,eyeR*2);
  }
  ctx.restore();
  const haloHue=(S._vizPhase*22)%360;
  const halo=ctx.createRadialGradient(cx,cy,eyeR*.85,cx,cy,eyeR*1.35);
  halo.addColorStop(0,`hsla(${haloHue},100%,70%,${0.18+S._bassSmooth*0.3})`);
  halo.addColorStop(1,'transparent');
  ctx.fillStyle=halo;ctx.fillRect(0,0,W,H);
}

// ── Mandala Rings ─────────────────────────────────────────────────────────────
function drawMandala(W,H,freq){
  const cx=W/2,cy=H/2,minD=Math.min(W,H);
  const rings=[
    {n:3,  r:minD*.07, fi:.02,  spd: .014},
    {n:5,  r:minD*.13, fi:.06,  spd:-.010},
    {n:7,  r:minD*.20, fi:.12,  spd: .008},
    {n:8,  r:minD*.28, fi:.22,  spd:-.006},
    {n:11, r:minD*.36, fi:.36,  spd: .005},
    {n:14, r:minD*.44, fi:.52,  spd:-.004},
  ];
  ctx.save();ctx.translate(cx,cy);
  rings.forEach((ring,ri)=>{
    const amp=freq[Math.floor(ring.fi*freq.length)]/255;
    const rot=S._vizPhase*ring.spd*80;
    const pr=minD*(0.028+amp*0.032);
    for(let i=0;i<ring.n;i++){
      const a=i/ring.n*Math.PI*2+rot;
      const px=Math.cos(a)*ring.r,py=Math.sin(a)*ring.r;
      const hue=(ri*42+i*(360/ring.n)+S._vizPhase*28)%360;
      ctx.save();ctx.translate(px,py);ctx.rotate(a+S._vizPhase*.5);
      ctx.fillStyle=`hsla(${hue},100%,62%,${0.5+amp*0.5})`;
      ctx.shadowColor=`hsla(${hue},100%,70%,0.7)`;ctx.shadowBlur=5+amp*14;
      ctx.beginPath();ctx.ellipse(0,0,pr*.45,pr,0,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;ctx.restore();
    }
  });
  const cHue=(S._vizPhase*24)%360;
  const cg=ctx.createRadialGradient(0,0,0,0,0,minD*.055);
  cg.addColorStop(0,`hsla(${cHue},100%,98%,.95)`);
  cg.addColorStop(0.5,`hsla(${(cHue+80)%360},100%,70%,.5)`);
  cg.addColorStop(1,'transparent');
  ctx.fillStyle=cg;ctx.beginPath();ctx.arc(0,0,minD*.055,0,Math.PI*2);ctx.fill();
  ctx.restore();
}

// ── Classic engines (original 4) ─────────────────────────────────────────────
function drawGalaxy(W,H,freq){
  const cx=W/2,cy=H/2,n=120;
  for(let i=0;i<n;i++){
    const amp=freq[i*2]/255;
    const angle=(i/n*Math.PI*2)+S._vizPhase*1.8;
    const r=50+amp*Math.min(W,H)*0.38;
    const x=cx+Math.cos(angle)*r,y=cy+Math.sin(angle)*r;
    const hue=(i/n*360+S._vizPhase*25)%360;
    ctx.strokeStyle=`hsla(${hue},100%,${48+amp*44}%,${0.25+amp*0.75})`;
    ctx.lineWidth=1+amp*2.5;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(x,y);ctx.stroke();
    if(amp>0.6){
      ctx.fillStyle=`hsla(${hue},100%,80%,${amp*0.5})`;
      ctx.beginPath();ctx.arc(x,y,amp*4,0,Math.PI*2);ctx.fill();
    }
  }
}
function drawAurora(W,H,freq){
  const bands=7;
  for(let b=0;b<bands;b++){
    const amp=freq[Math.floor(b*freq.length/bands)]/255;
    const hue=(b/bands*240+S._vizPhase*18+160)%360;
    ctx.beginPath();
    for(let x=0;x<=W;x+=3){
      const t=x/W;
      const y=H*(0.28+b*0.07)
        +Math.sin(t*7+S._vizPhase*(1+b*0.25))*H*(0.035+amp*0.07)
        +Math.sin(t*3.5-S._vizPhase*(0.6+b*0.18))*H*(0.018+amp*0.04);
      x===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    ctx.strokeStyle=`hsla(${hue},80%,62%,${0.12+amp*0.55})`;
    ctx.lineWidth=2+amp*5;ctx.stroke();
  }
}
function drawBars(W,H,freq){
  const n=96,bw=W/n;
  for(let i=0;i<n;i++){
    const amp=freq[Math.floor(i*freq.length/n)]/255;
    const h=amp*H*0.82,hue=(i/n*160+200)%360;
    const grad=ctx.createLinearGradient(0,H,0,H-h);
    grad.addColorStop(0,`hsla(${hue},100%,52%,0.85)`);
    grad.addColorStop(1,`hsla(${hue+50},100%,78%,0.4)`);
    ctx.fillStyle=grad;ctx.fillRect(i*bw+1,H-h,bw-2,h);
  }
}
function drawScope(W,H){
  const tbuf=new Uint8Array(S._analyser.fftSize);
  S._analyser.getByteTimeDomainData(tbuf);
  ctx.strokeStyle='rgba(140,255,255,0.75)';ctx.lineWidth=2;
  ctx.shadowColor='rgba(140,255,255,0.4)';ctx.shadowBlur=6;
  ctx.beginPath();
  for(let i=0;i<tbuf.length;i++){
    const x=i/tbuf.length*W,y=((tbuf[i]/128)-1)*H*0.38+H/2;
    i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
  }
  ctx.stroke();ctx.shadowBlur=0;
}

// ── Mask (2 presets) ──────────────────────────────────────────────────────────
function makeTileCanvas(pat,size,hue){
  const oc=document.createElement('canvas');oc.width=oc.height=size;
  const c=oc.getContext('2d');
  c.fillStyle=`hsl(${hue},80%,7%)`;c.fillRect(0,0,size,size);
  c.fillStyle=`hsl(${hue},100%,58%)`;c.strokeStyle=`hsl(${hue},100%,58%)`;
  if(pat==='dots'){
    const s=size/4;
    for(let x=s/2;x<size;x+=s)for(let y=s/2;y<size;y+=s){c.beginPath();c.arc(x,y,s*.26,0,Math.PI*2);c.fill();}
  }else if(pat==='lines'){
    c.lineWidth=1.5;
    for(let y=0;y<size;y+=size/5){c.beginPath();c.moveTo(0,y);c.lineTo(size,y);c.stroke();}
  }else if(pat==='grid'){
    c.lineWidth=1;
    for(let i=0;i<=size;i+=size/5){
      c.beginPath();c.moveTo(i,0);c.lineTo(i,size);c.stroke();
      c.beginPath();c.moveTo(0,i);c.lineTo(size,i);c.stroke();
    }
  }else if(pat==='chevron'){
    c.lineWidth=2;const h=size/3;
    for(let y=-h;y<size+h;y+=h){c.beginPath();c.moveTo(0,y+h/2);c.lineTo(size/2,y);c.lineTo(size,y+h/2);c.stroke();}
  }else if(pat==='rings'){
    c.lineWidth=1;
    for(let r=size*.12;r<size*.6;r+=size*.14){c.beginPath();c.arc(size/2,size/2,r,0,Math.PI*2);c.stroke();}
  }else if(pat==='hex'){
    c.lineWidth=1;const hr=size/4,hw=hr*Math.sqrt(3);
    for(let row=-1;row<4;row++)for(let col=-1;col<4;col++){
      const ox=col*hw+(row%2===0?0:hw/2),oy=row*hr*1.5;
      c.beginPath();
      for(let i=0;i<6;i++){const a=i/6*Math.PI*2;i===0?c.moveTo(ox+Math.cos(a)*hr,oy+Math.sin(a)*hr):c.lineTo(ox+Math.cos(a)*hr,oy+Math.sin(a)*hr);}
      c.closePath();c.stroke();
    }
  }
  return oc;
}
function getPattern(pat,size,hue){
  const key=`${pat}_${size}_${Math.round(hue/30)*30}`;
  if(!S._patCache[key]){S._patCache[key]=ctx.createPattern(makeTileCanvas(pat,size,hue),'repeat');}
  return S._patCache[key];
}
const _ACCENT={star5:'star6',star6:'star8',star8:'star5',hex:'diamond',diamond:'hex',flower:'circle',circle:'flower',cross:'triangle',triangle:'cross'};
function drawMask(W,H,p){
  const spd=.006+S._midsSmooth*.04;
  if(p.motion==='spin'){S._maskRot+=spd;S._patRot-=spd*.65;}
  else if(p.motion==='pulse'){S._maskRot+=.003+S._midsSmooth*.022;S._patRot+=.0025;}
  else{S._maskRot+=Math.sin(S._vizPhase)*.006;S._patRot+=.004;}
  const hue=p.hue<0?(S._vizPhase*12)%360:p.hue;
  const cx=W/2,cy=H/2;
  const r=Math.min(W,H)*(p.motion==='breathe'?.23+.055*Math.sin(S._vizPhase*.5):.24)*(1+S._bassSmooth*.55);
  const ag=ctx.createRadialGradient(cx,cy,r*.2,cx,cy,r*2);
  ag.addColorStop(0,`hsla(${hue},90%,48%,${.06+S._bassSmooth*.1})`);ag.addColorStop(1,'transparent');
  ctx.fillStyle=ag;ctx.fillRect(0,0,W,H);
  if(S._beatFlash>.04){
    const bf=ctx.createRadialGradient(cx,cy,0,cx,cy,r*2.8);
    bf.addColorStop(0,`hsla(${hue},100%,70%,${S._beatFlash*.28})`);bf.addColorStop(1,'transparent');
    ctx.fillStyle=bf;ctx.fillRect(0,0,W,H);
  }
  const pat=getPattern(p.pat,p.patSize||48,hue);
  ctx.save();ctx.translate(cx,cy);ctx.rotate(S._maskRot);buildShapePath(ctx,p.shape,r);ctx.clip();
  ctx.rotate(-S._maskRot+S._patRot);ctx.translate(-cx,-cy);ctx.fillStyle=pat;ctx.fillRect(0,0,W,H);
  ctx.restore();
  ctx.save();ctx.translate(cx,cy);ctx.rotate(S._maskRot);buildShapePath(ctx,p.shape,r);
  ctx.strokeStyle=`hsla(${hue},100%,72%,${.45+S._bassSmooth*.55})`;
  ctx.lineWidth=1.5+S._bassSmooth*3;ctx.shadowColor=`hsla(${hue},100%,72%,.55)`;ctx.shadowBlur=10+S._bassSmooth*22;
  ctx.stroke();ctx.shadowBlur=0;ctx.restore();
  const r2=r*(.52+S._hiSmooth*.3),aHue=(hue+p.accent)%360,accShape=_ACCENT[p.shape]||p.shape;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(-S._maskRot*1.4+S._vizPhase*.3);buildShapePath(ctx,accShape,r2);
  ctx.strokeStyle=`hsla(${aHue},100%,70%,${.25+S._hiSmooth*.6})`;
  ctx.lineWidth=1.5;ctx.shadowColor=`hsla(${aHue},100%,70%,.4)`;ctx.shadowBlur=8;
  ctx.stroke();ctx.shadowBlur=0;ctx.restore();
}

// ── Main render ───────────────────────────────────────────────────────────────
export function renderFrame(){
  requestAnimationFrame(renderFrame);
  const W=canvas.width,H=canvas.height;
  if(!S._analyser){ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);return;}
  const freq=new Uint8Array(S._analyser.frequencyBinCount);
  S._analyser.getByteFrequencyData(freq);
  const{bass,mids,hi,energy}=getAudioLevels(freq);
  S._bassSmooth=S._bassSmooth*.72+bass*.28;
  S._midsSmooth=S._midsSmooth*.72+mids*.28;
  S._hiSmooth  =S._hiSmooth  *.72+hi  *.28;
  S._beatAvg=S._beatAvg*.96+energy*.04;
  if(energy>S._beatAvg*1.45&&energy>.08)S._beatFlash=Math.min(1,S._beatFlash+.7);
  S._beatFlash*=.88;
  S._vizPhase+=0.018;
  ctx.fillStyle='rgba(0,0,0,0.15)';ctx.fillRect(0,0,W,H);
  const p=S.PRESETS[S._presetIdx];
  if(p.engine==='galaxy')            drawGalaxy(W,H,freq);
  else if(p.engine==='aurora')       drawAurora(W,H,freq);
  else if(p.engine==='bars')         drawBars(W,H,freq);
  else if(p.engine==='scope')        drawScope(W,H);
  else if(p.engine==='starfield')    drawStarfield(W,H,freq);
  else if(p.engine==='kaleidoscope') drawKaleidoscope(W,H,freq);
  else if(p.engine==='tunnel')       drawTunnel(W,H,freq,p.shape);
  else if(p.engine==='bubbles')      drawBubbles(W,H,freq);
  else if(p.engine==='lasers')       drawLasers(W,H,freq);
  else if(p.engine==='eye')          drawEye(W,H,freq);
  else if(p.engine==='mandala')      drawMandala(W,H,freq);
  else if(p.engine==='mask')         drawMask(W,H,p);
}
