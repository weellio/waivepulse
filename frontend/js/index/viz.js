import { S, VIZ_CYCLE, VIZ_LABELS } from './state.js';

// ── Visualizer ────────────────────────────────────────────────────────────────
export function getACtx() {
  if (!S._actx) S._actx = new (window.AudioContext || window.webkitAudioContext)();
  if (S._actx.state === 'suspended') S._actx.resume();
  return S._actx;
}

export function getAnalyser(audioEl) {
  if (S.audioNodes.has(audioEl)) return S.audioNodes.get(audioEl).analyser;
  const ctx     = getACtx();
  const source  = ctx.createMediaElementSource(audioEl);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  analyser.connect(ctx.destination);
  S.audioNodes.set(audioEl, { source, analyser });
  return analyser;
}

export function cycleVizStyle(jobId) {
  const cur  = S.vizStyles[jobId] || 'ring';
  const next = VIZ_CYCLE[(VIZ_CYCLE.indexOf(cur) + 1) % VIZ_CYCLE.length];
  S.vizStyles[jobId] = next;
  if (S.vizState[jobId]) S.vizState[jobId].pts = [];
  const btn = document.getElementById(`viz-btn-${jobId}`);
  if (btn) btn.textContent = VIZ_LABELS[next];
}

export function startViz(jobId, audioEl) {
  const canvas = document.getElementById(`viz-${jobId}`);
  if (!canvas) return;
  stopViz(jobId);
  if (!S.vizState[jobId]) S.vizState[jobId] = { t: 0 };
  const ctx2d    = canvas.getContext('2d');
  const analyser = getAnalyser(audioEl);
  const bufLen   = analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufLen);
  const timeData = new Uint8Array(bufLen);

  function frame() {
    S.vizFrames[jobId] = requestAnimationFrame(frame);
    const W = canvas.width, H = canvas.height;
    const style = S.vizStyles[jobId] || 'ring';
    const state = S.vizState[jobId];
    state.t = (state.t || 0) + 1;
    const t = state.t;
    ctx2d.clearRect(0, 0, W, H);
    if (style === 'wave' || style === 'scope') {
      analyser.getByteTimeDomainData(timeData);
      style === 'wave' ? drawWave(ctx2d,W,H,timeData,bufLen)
                       : drawScope(ctx2d,W,H,timeData,bufLen);
    } else {
      analyser.getByteFrequencyData(freqData);
      switch (style) {
        case 'ring':      drawRing(ctx2d,W,H,freqData,bufLen); break;
        case 'bars':      drawBars(ctx2d,W,H,freqData,bufLen); break;
        case 'galaxy':    drawGalaxy(ctx2d,W,H,freqData,bufLen,t); break;
        case 'aurora':    drawAurora(ctx2d,W,H,freqData,bufLen,t); break;
        case 'particles': drawParticles(ctx2d,W,H,freqData,bufLen,t,state); break;
      }
    }
  }
  frame();
}

export function stopViz(jobId) {
  if (S.vizFrames[jobId]) { cancelAnimationFrame(S.vizFrames[jobId]); delete S.vizFrames[jobId]; }
}

export function attachVizListeners(jobId) {
  const audioEl = document.querySelector(`#job-${jobId} audio`);
  if (!audioEl || audioEl._vizAttached) return;
  audioEl._vizAttached = true;
  if (!S.vizStyles[jobId]) S.vizStyles[jobId] = 'ring';
  audioEl.addEventListener('play',  () => startViz(jobId, audioEl));
  audioEl.addEventListener('pause', () => stopViz(jobId));
  audioEl.addEventListener('ended', () => stopViz(jobId));
}

export function attachMetaListeners(jobId) {
  const audioEl = document.querySelector(`#job-${jobId} audio`);
  if (!audioEl || audioEl._metaAttached) return;
  audioEl._metaAttached = true;
  audioEl.addEventListener('loadedmetadata', () => {
    const dur = audioEl.duration;
    if (isNaN(dur) || !isFinite(dur)) return;
    const m = Math.floor(dur / 60);
    const s = Math.floor(dur % 60).toString().padStart(2, '0');
    const durEl  = document.getElementById(`dur-${jobId}`);
    const metaEl = document.getElementById(`meta-${jobId}`);
    if (durEl)  durEl.textContent = `${m}:${s}`;
    if (metaEl) {
      const durSpanEl = metaEl.querySelector('.meta-dur');
      if (durSpanEl) {
        durSpanEl.textContent = `${m}:${s}`;
      } else {
        const span = document.createElement('span');
        span.className = 'meta-dur';
        span.textContent = `${m}:${s}`;
        metaEl.prepend(span);
      }
    }
  });
}

// ── Draw functions ────────────────────────────────────────────────────────────
export function drawRing(ctx, W, H, data, bufLen) {
  const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.25, N = 128;
  let avg = 0;
  for (let i = 0; i < 64; i++) avg += data[i];
  avg /= (64 * 255);
  const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * (0.9 + avg * 0.6));
  grd.addColorStop(0, `rgba(100, 60, 180, ${avg * 0.35})`);
  grd.addColorStop(0.6, `rgba(80, 40, 150, ${avg * 0.15})`);
  grd.addColorStop(1, 'transparent');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx, cy, r * (0.9 + avg * 0.6), 0, Math.PI * 2); ctx.fill();
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const v = data[Math.floor(i * bufLen / N)] / 255;
    const barH = v * r * 0.9 + 1.5;
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const hue = 255 + v * 75, light = 48 + v * 32;
    ctx.strokeStyle = `hsla(${hue}, 85%, ${light}%, ${0.35 + v * 0.65})`;
    ctx.shadowColor = `hsla(${hue}, 90%, 72%, ${v * 0.7})`;
    ctx.shadowBlur  = v * 10;
    ctx.lineWidth   = Math.max(1.5, (Math.PI * 2 * r / N) * 0.55);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * r,          cy + Math.sin(angle) * r);
    ctx.lineTo(cx + Math.cos(angle) * (r + barH), cy + Math.sin(angle) * (r + barH));
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.strokeStyle = `rgba(124, 92, 191, ${0.18 + avg * 0.35})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
}

export function drawBars(ctx, W, H, data, bufLen) {
  const count = 80, gap = 2;
  const barW = (W - gap * (count - 1)) / count;
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const v  = data[Math.floor(i * bufLen / count)] / 255;
    const bH = Math.max(2, v * (H - 8));
    const x  = i * (barW + gap);
    const hue = 230 + v * 90, light = 44 + v * 28;
    ctx.fillStyle   = `hsla(${hue}, 82%, ${light}%, ${0.5 + v * 0.5})`;
    ctx.shadowColor = `hsla(${hue}, 85%, 68%, ${v * 0.55})`;
    ctx.shadowBlur  = v * 8;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, H - bH, barW, bH, [barW * 0.4, barW * 0.4, 0, 0]);
    else ctx.rect(x, H - bH, barW, bH);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

export function drawWave(ctx, W, H, data, bufLen) {
  ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.shadowColor = '#8b60d8'; ctx.shadowBlur = 8;
  ctx.beginPath();
  for (let i = 0; i < bufLen; i++) {
    const x = (i / (bufLen - 1)) * W, y = (data[i] / 128.0) * (H / 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  for (let i = bufLen - 1; i >= 0; i--) {
    const x = (i / (bufLen - 1)) * W, y = H - (data[i] / 128.0) * (H / 2);
    ctx.lineTo(x, y);
  }
  ctx.closePath();
  const fg = ctx.createLinearGradient(0, 0, 0, H);
  fg.addColorStop(0, 'rgba(124, 92, 191, 0.15)');
  fg.addColorStop(0.5, 'rgba(160, 120, 240, 0.08)');
  fg.addColorStop(1, 'rgba(124, 92, 191, 0.15)');
  ctx.fillStyle = fg; ctx.fill();
  ctx.strokeStyle = '#6de8e8'; ctx.beginPath();
  for (let i = 0; i < bufLen; i++) {
    const x = (i / (bufLen - 1)) * W, y = (data[i] / 128.0) * (H / 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.strokeStyle = '#2ab8b8'; ctx.beginPath();
  for (let i = 0; i < bufLen; i++) {
    const x = (i / (bufLen - 1)) * W, y = H - (data[i] / 128.0) * (H / 2);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

export function drawGalaxy(ctx, W, H, data, bufLen, t) {
  const cx = W/2, cy = H/2, maxR = Math.min(W,H) * 0.44;
  const N = 200;
  let bass = 0;
  for (let i=0;i<10;i++) bass += data[i];
  bass /= (10*255);
  const rot = t * 0.00025;
  const grd = ctx.createRadialGradient(cx,cy,0,cx,cy,maxR*0.5);
  grd.addColorStop(0, `rgba(80,40,160,${bass*0.45})`);
  grd.addColorStop(1, 'transparent');
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(cx,cy,maxR*0.5,0,Math.PI*2); ctx.fill();
  ctx.save();
  ctx.translate(cx,cy);
  for (let i=0;i<N;i++) {
    const v   = data[Math.floor(i*bufLen*0.7/N)] / 255;
    const ang = (i/N)*Math.PI*2 + rot;
    const r0  = maxR*0.07, r1 = r0 + v*maxR*0.92;
    const hue = (i/N)*300 + t*0.03;
    ctx.strokeStyle = `hsla(${hue},90%,65%,${0.15+v*0.85})`;
    ctx.shadowColor = `hsla(${hue},90%,70%,${v*0.5})`;
    ctx.shadowBlur  = v*14;
    ctx.lineWidth   = 1+v*2.5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang)*r0, Math.sin(ang)*r0);
    ctx.lineTo(Math.cos(ang)*r1, Math.sin(ang)*r1);
    ctx.stroke();
  }
  ctx.shadowBlur  = 20;
  ctx.shadowColor = '#b8ffff';
  ctx.fillStyle   = `rgba(180,140,255,${0.6+bass*0.4})`;
  ctx.beginPath(); ctx.arc(0,0,4+bass*8,0,Math.PI*2); ctx.fill();
  ctx.restore();
  ctx.shadowBlur = 0;
}

export function drawAurora(ctx, W, H, data, bufLen, t) {
  const bands = 7;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let b=0;b<bands;b++) {
    const lo = Math.floor((b/bands)*bufLen*0.6);
    const hi = Math.floor(((b+1)/bands)*bufLen*0.6);
    let avg = 0;
    for (let i=lo;i<hi;i++) avg += data[i];
    avg /= ((hi-lo)*255);
    const baseY = H*(0.2 + b*0.1);
    const amp   = avg*H*0.28 + 4;
    const hue   = 160 + b*28 + t*0.015;
    ctx.beginPath();
    ctx.moveTo(0,H);
    for (let x=0;x<=W;x+=3) {
      const nx = x/W;
      const y  = baseY
               + Math.sin(nx*Math.PI*3 + t*0.0008 + b*1.1)*amp
               + Math.sin(nx*Math.PI*5 - t*0.0006 + b*0.7)*amp*0.4
               + Math.sin(nx*Math.PI*2 + t*0.0012)*amp*0.25;
      ctx.lineTo(x,y);
    }
    ctx.lineTo(W,H); ctx.closePath();
    const gr = ctx.createLinearGradient(0,baseY-amp*1.5,0,H);
    gr.addColorStop(0, `hsla(${hue},90%,65%,${0.1+avg*0.45})`);
    gr.addColorStop(0.6, `hsla(${hue+20},85%,55%,${(0.1+avg*0.45)*0.3})`);
    gr.addColorStop(1, `hsla(${hue},90%,65%,0)`);
    ctx.fillStyle = gr; ctx.fill();
  }
  ctx.restore();
}

export function drawParticles(ctx, W, H, data, bufLen, t, state) {
  const cx = W/2, cy = H/2;
  if (!state.pts) state.pts = [];
  for (let i=0;i<14;i++) {
    const bin = Math.floor(Math.random()*bufLen*0.7);
    const v   = data[bin]/255;
    if (v < 0.28) continue;
    const ang = Math.random()*Math.PI*2;
    const spd = 1 + v*5;
    state.pts.push({
      x:cx, y:cy,
      vx: Math.cos(ang)*spd, vy: Math.sin(ang)*spd,
      life: 1,
      decay: 0.01 + Math.random()*0.02,
      r: 1+v*3.5,
      hue: (bin/bufLen)*300 + t*0.05,
    });
  }
  state.pts = state.pts.filter(p => p.life > 0);
  for (const p of state.pts) {
    p.x  += p.vx; p.y  += p.vy;
    p.vy += 0.04;
    p.life -= p.decay;
    ctx.globalAlpha  = p.life * 0.85;
    ctx.fillStyle    = `hsl(${p.hue},90%,65%)`;
    ctx.shadowColor  = `hsl(${p.hue},90%,70%)`;
    ctx.shadowBlur   = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r*p.life, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.shadowBlur = 0;
}

export function drawScope(ctx, W, H, data, bufLen) {
  const cy = H/2;
  let start = 0;
  for (let i=1;i<bufLen-1;i++) {
    if (data[i-1]<128 && data[i]>=128) { start=i; break; }
  }
  const slice = W / (bufLen - start);
  ctx.lineWidth=6; ctx.strokeStyle='rgba(100,180,255,0.07)'; ctx.shadowBlur=0;
  ctx.beginPath();
  for (let i=0;i<bufLen-start;i++) {
    const y = cy + ((data[start+i]/128.0)-1)*cy*0.85;
    i===0 ? ctx.moveTo(i*slice,y) : ctx.lineTo(i*slice,y);
  }
  ctx.stroke();
  ctx.lineWidth=2; ctx.strokeStyle='#88ddff';
  ctx.shadowColor='#44aaff'; ctx.shadowBlur=14;
  ctx.lineCap='round'; ctx.lineJoin='round';
  ctx.beginPath();
  for (let i=0;i<bufLen-start;i++) {
    const y = cy + ((data[start+i]/128.0)-1)*cy*0.85;
    i===0 ? ctx.moveTo(i*slice,y) : ctx.lineTo(i*slice,y);
  }
  ctx.stroke();
  ctx.strokeStyle='rgba(68,170,255,0.1)'; ctx.shadowBlur=0; ctx.lineWidth=1;
  ctx.setLineDash([4,8]);
  ctx.beginPath(); ctx.moveTo(0,cy); ctx.lineTo(W,cy); ctx.stroke();
  ctx.setLineDash([]); ctx.shadowBlur=0;
}

// ── Fullscreen visualizer ──────────────────────────────────────────────────────
export function launchFullscreen(jobId) {
  const audioEl = document.querySelector(`#job-${jobId} audio`);
  if (!audioEl) return;
  S._fsJobId    = jobId;
  S._fsStyle    = S.vizStyles[jobId] || 'ring';
  S._fsState    = {};
  S._fsAudioEl  = audioEl;
  const titleEl = document.querySelector(`#job-${jobId} .job-title`);
  document.getElementById('fs-title').textContent = titleEl ? titleEl.textContent : '';
  document.getElementById('fs-style-btn').textContent = VIZ_LABELS[S._fsStyle] || '◉ Ring';
  _syncFsPlayBtn();
  audioEl.addEventListener('play',  _syncFsPlayBtn);
  audioEl.addEventListener('pause', _syncFsPlayBtn);
  audioEl.addEventListener('ended', _syncFsPlayBtn);
  const overlay = document.getElementById('fs-overlay');
  overlay.style.display = 'flex';
  overlay.requestFullscreen().catch(() => {});
  startFsViz(audioEl);
}

export function _syncFsPlayBtn() {
  const btn = document.getElementById('fs-play-btn');
  if (!btn || !S._fsAudioEl) return;
  btn.textContent = S._fsAudioEl.paused ? '▶' : '⏸';
}

export function toggleFsPlay() {
  if (!S._fsAudioEl) return;
  S._fsAudioEl.paused ? S._fsAudioEl.play() : S._fsAudioEl.pause();
}

export function startFsViz(audioEl) {
  if (S._fsRafId) cancelAnimationFrame(S._fsRafId);
  const canvas   = document.getElementById('fs-canvas');
  const ctx      = canvas.getContext('2d');
  const analyser = getAnalyser(audioEl);
  analyser.fftSize = 2048;
  const bufLen   = analyser.frequencyBinCount;
  const freqData = new Uint8Array(bufLen);
  const timeData = new Uint8Array(bufLen);
  function frame() {
    S._fsRafId = requestAnimationFrame(frame);
    const overlay = document.getElementById('fs-overlay');
    const W = overlay.clientWidth, H = overlay.clientHeight;
    if (canvas.width !== W || canvas.height !== H) { canvas.width=W; canvas.height=H; }
    ctx.clearRect(0,0,W,H);
    S._fsState.t = (S._fsState.t||0) + 1;
    const t = S._fsState.t;
    if (S._fsStyle==='wave'||S._fsStyle==='scope') {
      analyser.getByteTimeDomainData(timeData);
      S._fsStyle==='wave' ? drawWave(ctx,W,H,timeData,bufLen)
                        : drawScope(ctx,W,H,timeData,bufLen);
    } else {
      analyser.getByteFrequencyData(freqData);
      switch (S._fsStyle) {
        case 'ring':      drawRing(ctx,W,H,freqData,bufLen); break;
        case 'bars':      drawBars(ctx,W,H,freqData,bufLen); break;
        case 'galaxy':    drawGalaxy(ctx,W,H,freqData,bufLen,t); break;
        case 'aurora':    drawAurora(ctx,W,H,freqData,bufLen,t); break;
        case 'particles': drawParticles(ctx,W,H,freqData,bufLen,t,S._fsState); break;
      }
    }
  }
  frame();
}

export function exitFs() {
  if (S._fsRafId) { cancelAnimationFrame(S._fsRafId); S._fsRafId=null; }
  if (S._fsAudioEl) {
    S._fsAudioEl.removeEventListener('play',  _syncFsPlayBtn);
    S._fsAudioEl.removeEventListener('pause', _syncFsPlayBtn);
    S._fsAudioEl.removeEventListener('ended', _syncFsPlayBtn);
    S._fsAudioEl = null;
  }
  if (document.fullscreenElement) document.exitFullscreen();
  document.getElementById('fs-overlay').style.display='none';
}

export function cycleFsStyle() {
  const next = VIZ_CYCLE[(VIZ_CYCLE.indexOf(S._fsStyle)+1) % VIZ_CYCLE.length];
  S._fsStyle = next;
  S._fsState = {};
  document.getElementById('fs-style-btn').textContent = VIZ_LABELS[next];
}
