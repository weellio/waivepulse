/* ============================================================
   WAIvePulse landing — scroll-driven motion for the page's visuals

   The background canvas (app.js) already reacts to scroll. This does the same for the
   things you actually read: every screenshot drifts sideways, zooms and settles as it
   crosses the viewport, and its accent colour comes up with it.

   Three rules kept it from feeling like a demo reel:

   * One rAF loop, and only for elements currently near the viewport. An IntersectionObserver
     decides who is live; everything else costs nothing. The loop stops itself when the list
     empties, so a parked page is not burning a frame budget.
   * Every value is eased in JS (lerp toward a target) rather than with a CSS transition.
     A transition on transform fights a per-frame write and shows up as lag on a trackpad.
   * Nothing here moves text. Body copy stays exactly where it was painted — the owner reads
     with dyslexia and sliding paragraphs are genuinely hard to follow.

   prefers-reduced-motion: this file does nothing at all.
   ============================================================ */
(() => {
  'use strict';

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  // Ease the centred signal so the settle is soft at both ends.
  const smooth = t => t * t * (3 - 2 * t);

  /* ---------- the set of things that move ---------- */
  // dx:  how far it slides in sideways, px, signed
  // dy:  parallax travel over the whole crossing, px
  // zoom: how much it grows from its smallest to centred
  // rot: tilt at the edges, degrees, signed
  // img: how much the picture inside the frame zooms (Ken Burns)
  // vars: also write --c (0 at the edges, 1 centred) onto this element
  const items = [];
  function track(el, cfg) {
    if (!el) return;
    items.push({
      el,
      cfg,
      varEl: cfg.varEl || el,
      cur: { tx: 0, ty: 0, sc: 1, rot: 0, img: 1, c: 0 },
      live: false,
      fresh: true,
      hover: 0,
    });
  }

  // Feature screenshots: the big ones. They come in from the side the text is not on,
  // which is what gives the page its left-right rock as you scroll.
  document.querySelectorAll('.feature').forEach((f, i) => {
    const flip = f.classList.contains('flip');
    const dir = flip ? -1 : 1;
    track(f.querySelector('.shot-frame'), {
      dx: 74 * dir, dy: -46, zoom: 0.085, rot: 1.5 * dir, img: 0.13,
    });
    track(f.querySelector('.f-tag'), { dx: 26 * -dir, dy: 0, zoom: 0, rot: 0, img: 0 });
  });

  // Gallery cards: smaller moves, alternating side, so a grid of them ripples rather
  // than marching. The card itself carries --c so its accent colour can come up too.
  document.querySelectorAll('.gcard').forEach((g, i) => {
    const dir = i % 2 ? -1 : 1;
    track(g.querySelector('.shot-frame'), {
      dx: 46 * dir, dy: -30, zoom: 0.07, rot: 1.1 * dir, img: 0.10, varEl: g,
    });
  });

  // Section headings slide a little against the scroll. Short, large, and not body copy.
  document.querySelectorAll('.section-title, .final-card h2').forEach((h, i) => {
    track(h, { dx: 54 * (i % 2 ? -1 : 1), dy: 0, zoom: 0.03, rot: 0, img: 0 });
  });

  // The flow strip reads left to right, so its labels fan out from the middle.
  const steps = [...document.querySelectorAll('.flow-step .lbl')];
  steps.forEach((s, i) => {
    const mid = (steps.length - 1) / 2;
    track(s, { dx: (i - mid) * 22, dy: 0, zoom: 0.05, rot: 0, img: 0 });
  });

  // The hero recedes as you leave it, so the canvas tunnel takes over cleanly.
  const heroInner = document.querySelector('.hero-inner');

  /* ---------- hover adds to the same transform, instead of replacing it ---------- */
  document.querySelectorAll('.f-shot, .gcard').forEach(card => {
    const frame = card.querySelector('.shot-frame');
    const it = items.find(x => x.el === frame);
    if (!it) return;
    card.addEventListener('pointerenter', () => { it.hover = 1; });
    card.addEventListener('pointerleave', () => { it.hover = 0; });
  });

  /* ---------- who is close enough to bother with ---------- */
  let liveCount = 0;
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      const it = items.find(x => x.el === en.target);
      if (!it || it.live === en.isIntersecting) continue;
      it.live = en.isIntersecting;
      // Jump straight to where it should be the first time it wakes up. Easing in from
      // the identity transform made an arriving card slide out to its offset and then
      // come back, which is the opposite of what it should look like.
      if (en.isIntersecting) it.fresh = true;
      liveCount += en.isIntersecting ? 1 : -1;
    }
    if (liveCount > 0 && !running) start();
  }, { rootMargin: '25% 0px 25% 0px' });
  items.forEach(it => io.observe(it.el));

  /* ---------- the loop ---------- */
  let running = false, settleFrames = 0;

  // Sideways drift is a luxury of a wide screen. At phone width the same 74px would push a
  // card past the edge of a single-column layout, so it is mostly dialled out.
  let driftScale = 1;
  const measure = () => { driftScale = innerWidth < 900 ? 0.3 : innerWidth < 1200 ? 0.7 : 1; };
  measure();
  addEventListener('resize', measure);

  function frame() {
    const vh = innerHeight;
    let moving = false;

    for (const it of items) {
      if (!it.live) continue;
      const r = it.el.getBoundingClientRect();
      // 0 as it appears at the bottom, 1 as it leaves the top.
      const p = clamp((vh - r.top) / (vh + r.height), 0, 1);
      const c = smooth(1 - Math.abs(p * 2 - 1));
      const away = 1 - c;
      const k = it.cfg;

      const tgt = {
        tx: k.dx * away * driftScale,
        ty: k.dy * (p - 0.5) * 2,
        sc: 1 - k.zoom * away + it.hover * 0.02,
        rot: k.rot * away,
        img: 1 + k.img * away,
        c,
      };

      for (const key in tgt) {
        it.cur[key] = it.fresh ? tgt[key] : lerp(it.cur[key], tgt[key], 0.14);
        if (Math.abs(tgt[key] - it.cur[key]) > 0.0006) moving = true;
      }
      it.fresh = false;

      const q = it.cur;
      it.el.style.transform =
        `translate3d(${q.tx.toFixed(2)}px,${q.ty.toFixed(2)}px,0) ` +
        `scale(${q.sc.toFixed(4)}) rotate(${q.rot.toFixed(3)}deg)`;
      if (k.img) it.el.style.setProperty('--imgsc', q.img.toFixed(4));
      it.varEl.style.setProperty('--c', q.c.toFixed(3));
    }

    if (heroInner) {
      const p = clamp(scrollY / innerHeight, 0, 1);
      heroInner.style.transform = `translate3d(0,${(p * -60).toFixed(1)}px,0) scale(${(1 - p * 0.07).toFixed(4)})`;
      heroInner.style.opacity = (1 - p * 0.85).toFixed(3);
    }

    // Keep running for a moment after everything has settled, so the next scroll tick
    // is never waiting on a cold loop.
    settleFrames = moving ? 0 : settleFrames + 1;
    if (liveCount > 0 && settleFrames < 90 && !document.hidden) requestAnimationFrame(frame);
    else running = false;
  }

  function start() { running = true; settleFrames = 0; requestAnimationFrame(frame); }

  const wake = () => { settleFrames = 0; if (!running && liveCount > 0) start(); };
  addEventListener('scroll', wake, { passive: true });
  addEventListener('resize', wake);
  addEventListener('visibilitychange', wake);
  start();
})();
