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
  addEventListener('resize', resize);

  addEventListener('pointermove', e => {
    mouse.x = e.clientX / innerWidth;
    mouse.y = e.clientY / innerHeight;
    targetEnergy = Math.min(1, targetEnergy + 0.012);
  });

  let t = 0;
  function draw() {
    t += 0.016;
    energy += (targetEnergy - energy) * 0.04;
    targetEnergy += (0.32 - targetEnergy) * 0.01; // decay toward idle baseline

    ctx.clearRect(0, 0, W, H);
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
      ctx.strokeStyle = grad;
      ctx.lineWidth = s.width * dpr;
      ctx.shadowColor = `rgba(${s.color},0.8)`;
      ctx.shadowBlur = (10 + energy * 16) * dpr;
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    requestAnimationFrame(draw);
  }
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) draw();

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
