/* ============================================================
   WAIvePulse landing — canvas waveform + scroll interactions
   ============================================================ */
(() => {
  'use strict';

  /* ---------- Animated waveform background ---------- */
  const canvas = document.getElementById('bg');
  const ctx = canvas.getContext('2d');
  let W, H, dpr;

  // Brand-coloured strands, echoing the logo
  const STRANDS = [
    { color: '140,255,255', amp: 1.00, speed: 0.55, freq: 1.6, phase: 0,   width: 2.4 },
    { color: '74,222,128',  amp: 0.86, speed: 0.42, freq: 1.9, phase: 1.1, width: 2.0 },
    { color: '167,139,250', amp: 0.72, speed: 0.68, freq: 1.3, phase: 2.3, width: 1.8 },
    { color: '244,114,182', amp: 0.58, speed: 0.50, freq: 2.2, phase: 3.4, width: 1.4 },
  ];

  // Mouse + energy state (energy rises on scroll/move, decays to an idle baseline)
  const mouse = { x: 0.5, y: 0.5 };
  let energy = 0.35, targetEnergy = 0.35;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.width = innerWidth * dpr;
    H = canvas.height = innerHeight * dpr;
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
  }
  resize();
  addEventListener('resize', () => { resize(); if (typeof buildStars === 'function') buildStars(); });

  addEventListener('pointermove', e => {
    mouse.x = e.clientX / innerWidth;
    mouse.y = e.clientY / innerHeight;
    targetEnergy = Math.min(1, targetEnergy + 0.012);
  });

  /* ---------- Scroll-driven vortex: sound waves spiralling toward you ----------
     Scroll is the camera. Rings of waveform recede to a vanishing point and sweep
     outward past the viewer as you go down the page, while the sky travels from a
     dawn teal to deep night and stars come out near the bottom. Pure canvas, no
     library, and it idles at a crawl when nothing is moving. */
  const SKY = [
    { p: 0.00, top: '#071a1c', bot: '#04121a' },   // dawn over water
    { p: 0.38, top: '#0a2230', bot: '#06141f' },   // open day
    { p: 0.72, top: '#1b1130', bot: '#0b0a1c' },   // dusk
    { p: 1.00, top: '#0a0718', bot: '#05040d' },   // night
  ];
  // Ring colour travels with the sky: cyan -> green -> violet -> magenta-violet
  const RING = [
    { p: 0.00, c: [140, 255, 255] },
    { p: 0.38, c: [ 74, 222, 128] },
    { p: 0.72, c: [167, 139, 250] },
    { p: 1.00, c: [244, 114, 182] },
  ];
  const RINGS = 22, SEGS = 96;

  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const lerp = (a, b, t) => a + (b - a) * t;

  function stopAt(stops, p, pick) {
    let i = 0;
    while (i < stops.length - 2 && p > stops[i + 1].p) i++;
    const a = stops[i], b = stops[i + 1];
    const t = b.p === a.p ? 0 : (p - a.p) / (b.p - a.p);
    return [pick(a), pick(b), Math.max(0, Math.min(1, t))];
  }
  function skyAt(p) {
    const [a, b, t] = stopAt(SKY, p, s => s);
    const mix = (x, y) => hex(x).map((v, i) => Math.round(lerp(v, hex(y)[i], t)));
    return { top: mix(a.top, b.top), bot: mix(a.bot, b.bot) };
  }
  function ringAt(p) {
    const [a, b, t] = stopAt(RING, p, s => s.c);
    return a.map((v, i) => Math.round(lerp(v, b[i], t)));
  }

  // Stars are drawn once into an offscreen canvas and faded in, not recomputed per frame.
  let starLayer = null;
  function buildStars() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    for (let i = 0; i < 90; i++) {
      const x = Math.random() * W, y = Math.random() * H * 0.8;
      const r = (Math.random() * 1.3 + 0.4) * dpr;
      g.globalAlpha = 0.35 + Math.random() * 0.65;
      g.fillStyle = '#eaf6ff';
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    starLayer = c;
  }

  // 0 at the top of the page, 1 at the bottom.
  let scrollP = 0, scrollTarget = 0;
  function readScroll() {
    const max = document.documentElement.scrollHeight - innerHeight;
    scrollTarget = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
  }

  function drawSky(p) {
    const s = skyAt(p);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, `rgb(${s.top.join(',')})`);
    g.addColorStop(1, `rgb(${s.bot.join(',')})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const starFade = Math.max(0, (p - 0.5) / 0.4);
    if (starFade > 0.01 && starLayer) {
      ctx.globalAlpha = Math.min(1, starFade) * 0.85;
      ctx.drawImage(starLayer, 0, 0);
      ctx.globalAlpha = 1;
    }
  }

  function drawVortex(p, time) {
    const cx = W * (0.5 + (mouse.x - 0.5) * 0.06);
    const cy = H * (0.46 + (mouse.y - 0.5) * 0.06);
    const col = ringAt(p);
    // The camera travels 6 rings' worth over the whole page, plus a slow idle drift,
    // so the tunnel keeps breathing even when the page is still.
    const travel = p * RINGS * 0.42 + time * 0.045;
    const reach = Math.hypot(W, H) * 0.62;

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < RINGS; i++) {
      // z: 1 = far at the vanishing point, 0 = sweeping past the viewer
      const z = ((i / RINGS) - travel % 1 + 1) % 1;
      const depth = 0.045 + z * z * 0.955;           // perspective: far rings bunch up
      const radius = reach * depth;
      if (radius < 6 * dpr) continue;

      const near = 1 - z;                             // how close to the viewer
      const alpha = Math.min(1, z * 2.6) * (0.10 + 0.5 * near) * (0.55 + energy * 0.45);
      if (alpha < 0.012) continue;

      // Each ring is a waveform wrapped into a circle; the phase rotates with depth,
      // which is what reads as a spiral rather than a stack of circles.
      // A bigger phase step per ring lines the wave crests up into spiral arms across depth;
      // at 0.38 they read as plain concentric rings when the page is still.
      const spin = time * 0.12 + i * 0.62 + p * 2.2;
      const wob = (0.13 + 0.20 * near) * (0.6 + energy * 0.7);

      ctx.beginPath();
      for (let s = 0; s <= SEGS; s++) {
        const a = (s / SEGS) * 6.2832;
        const wave = Math.sin(a * 5 + spin * 2) + 0.45 * Math.sin(a * 11 - spin * 1.4)
                   + 0.25 * Math.sin(a * 2 + spin * 0.7);
        const r = radius * (1 + wave * wob * 0.11);
        const x = cx + Math.cos(a + spin * 0.25) * r;
        const y = cy + Math.sin(a + spin * 0.25) * r * 0.78;   // slight tilt, like a disc
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
      // Glow by stroking twice (a wide soft halo, then a bright core) instead of shadowBlur.
      // Measured on an RTX 3060: 22 rings with shadowBlur ran at 27 fps, the same rings with
      // this double stroke at 60. The JS cost is identical; the blur stalls the GPU.
      ctx.strokeStyle = `rgba(${col.join(',')},${(alpha * 0.22).toFixed(3)})`;
      ctx.lineWidth = (2.5 + near * 9) * dpr;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${col.join(',')},${alpha.toFixed(3)})`;
      ctx.lineWidth = (0.6 + near * 2.0) * dpr;
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    ctx.globalCompositeOperation = 'source-over';
  }

  let t = 0;
  function draw() {
    t += 0.016;
    energy += (targetEnergy - energy) * 0.04;
    targetEnergy += (0.32 - targetEnergy) * 0.01; // decay toward idle baseline
    scrollP += (scrollTarget - scrollP) * 0.08;   // ease the camera, scroll alone is jumpy

    drawSky(scrollP);
    drawVortex(scrollP, t);

    // The logo's pulse belongs to the hero; it hands over to the tunnel as you leave it.
    const strandFade = Math.max(0, 1 - scrollP / 0.22);
    if (strandFade > 0.01) {
    ctx.globalCompositeOperation = 'lighter';

    const midY = H * (0.46 + (mouse.y - 0.5) * 0.12);
    const baseAmp = H * 0.16 * (0.6 + energy);
    const step = 6 * dpr;

    for (const s of STRANDS) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += step) {
        const nx = x / W;
        // A windowed wave: tallest in the centre, like the logo's pulse
        const window = Math.sin(nx * Math.PI);
        const wob = Math.sin(nx * Math.PI * 2 * s.freq + t * s.speed * 2 + s.phase)
                  + 0.5 * Math.sin(nx * Math.PI * 5 * s.freq - t * s.speed * 1.3 + s.phase);
        const lean = (mouse.x - 0.5) * 0.6 * Math.sin(nx * Math.PI);
        const y = midY + wob * baseAmp * s.amp * (window * 0.85 + 0.15) + lean * H * 0.1;
        x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0,   `rgba(${s.color},0)`);
      grad.addColorStop(0.5, `rgba(${s.color},${0.5 + energy * 0.35})`);
      grad.addColorStop(1,   `rgba(${s.color},0)`);
      ctx.globalAlpha = strandFade;
      // Same reason as the rings: a halo stroke instead of shadowBlur. Four blurred paths
      // cost more than every ring in the tunnel put together.
      ctx.strokeStyle = grad;
      ctx.lineWidth = (s.width + 5) * dpr;
      ctx.globalAlpha = strandFade * 0.18;
      ctx.stroke();
      ctx.globalAlpha = strandFade;
      ctx.lineWidth = s.width * dpr;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    if (!document.hidden) requestAnimationFrame(draw);
    else setTimeout(() => requestAnimationFrame(draw), 400);   // sleep in a background tab
  }

  addEventListener('scroll', readScroll, { passive: true });
  readScroll();
  scrollP = scrollTarget;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches) {
    // One still frame: the picture, none of the motion.
    buildStars(); drawSky(scrollTarget); drawVortex(scrollTarget, 0);
    addEventListener('scroll', () => { readScroll(); scrollP = scrollTarget;
      drawSky(scrollP); drawVortex(scrollP, 0); }, { passive: true });
  } else {
    buildStars();
    draw();
  }

  /* ---------- Parallax orbs ---------- */
  const orbs = document.querySelectorAll('.orb');
  addEventListener('pointermove', e => {
    const dx = (e.clientX / innerWidth - 0.5);
    const dy = (e.clientY / innerHeight - 0.5);
    orbs.forEach((o, i) => {
      const depth = (i + 1) * 18;
      o.style.transform = `translate(${dx * depth}px, ${dy * depth}px)`;
    });
  });

  /* ---------- Nav shrink on scroll ---------- */
  const nav = document.getElementById('nav');
  const onScroll = () => {
    nav.classList.toggle('scrolled', scrollY > 30);
    targetEnergy = Math.min(1, targetEnergy + 0.006);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
    }
  }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));

  /* ---------- Accent the nav as you pass each feature ---------- */
  const accentMap = { cyan: '#8cffff', green: '#4ade80', purple: '#a78bfa', magenta: '#f472b6', amber: '#fbbf24' };
  const featObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const a = en.target.getAttribute('data-accent');
        document.documentElement.style.setProperty('--accent', accentMap[a] || '#8cffff');
      }
    }
  }, { threshold: 0.5 });
  document.querySelectorAll('.feature').forEach(f => featObserver.observe(f));

  /* ---------- Count-up stats ---------- */
  const counters = document.querySelectorAll('.big[data-count]');
  const cio = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const el = en.target;
      const target = +el.dataset.count;
      let n = 0;
      const tick = () => {
        n += Math.max(1, Math.ceil(target / 24));
        if (n >= target) { el.textContent = target; }
        else { el.textContent = n; requestAnimationFrame(tick); }
      };
      tick();
      cio.unobserve(el);
    }
  }, { threshold: 0.6 });
  counters.forEach(c => cio.observe(c));

  /* ---------- Smooth-scroll for in-page nav links ---------- */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const el = document.querySelector(id);
      if (el) { e.preventDefault(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
  });
})();
