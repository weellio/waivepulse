/* ============================================================
   WAIvePulse landing — scroll-driven motion

   Three separate things happen to every picture on this page:

   1. ENTRANCE. The first time it comes into view it flies in from off the side of the
      screen, fading up as it lands. Cards in the same row are staggered, so a row deals
      itself in rather than appearing all at once.
   2. TRAVEL. After it has landed it keeps drifting, zooming and tilting as you scroll,
      so the page is never static while the wheel is moving.
   3. ACTION. A playhead sweeps across each frame on a loop — a scan line, a soft light
      behind it, and a progress bar along the bottom edge in the card's own accent. That
      is the part that makes a still screenshot look like a tool doing something. It
      pauses whenever the card is off screen.

   Why it is written this way:

   * One rAF loop for 1 and 2, and only for elements an IntersectionObserver says are
     near the viewport. The loop stops itself when they all settle.
   * Everything is eased in JS rather than with a CSS transition. A transition on
     transform fights a per-frame write and shows up as lag on a trackpad.
   * Part 3 is pure CSS animation, so it costs nothing per frame and keeps running
     smoothly even while the main thread is busy.
   * No body text moves. Headings and pictures do; paragraphs stay where they were
     painted, because sliding text is genuinely hard to read.

   prefers-reduced-motion: none of this runs.
   ============================================================ */
(() => {
  'use strict';

  /* ---------- the Motion switch ----------
     Wired up before anything else, because it has to work in the very case where the rest
     of this file does not run. The inline script in <head> has already resolved the
     preference; this only reflects it and flips it. Flipping reloads, which is cruder than
     tearing the loop down and rebuilding it, and is also the only version that cannot
     leave the page in a half-animated state. */
  const root = document.documentElement;
  const btn = document.getElementById('motion-toggle');
  const motionOn = () => root.dataset.motion === 'on';

  const choose = on => {
    try { localStorage.setItem('wp-motion', on ? 'on' : 'off'); } catch (e) {}
    location.reload();
  };

  if (btn) {
    const lbl = btn.querySelector('.motion-lbl');
    const paint = () => {
      btn.classList.toggle('off', !motionOn());
      btn.setAttribute('aria-pressed', String(motionOn()));
      /* Switched off, the label is an instruction, not a status. "Motion off" reads as a
         caption and gets scrolled past; "Turn on motion" reads as a button. */
      if (lbl) lbl.textContent = motionOn() ? 'Motion on' : 'Turn on motion';
      btn.title = motionOn() ? 'Turn the page’s animation off'
                             : 'Turn the page’s animation on';
      btn.setAttribute('aria-label', btn.title);
    };
    paint();
    btn.addEventListener('click', () => choose(!motionOn()));
  }

  /* The bar at the bottom. Either button records a decision, which is also what stops
     the bar coming back: the head script only asks a visitor who has never answered. */
  const ask = document.getElementById('motion-ask');
  if (ask) {
    const yes = document.getElementById('motion-ask-on');
    const no = document.getElementById('motion-ask-no');
    if (yes) yes.addEventListener('click', () => choose(true));
    if (no) no.addEventListener('click', () => {
      try { localStorage.setItem('wp-motion', 'off'); } catch (e) {}
      root.removeAttribute('data-motion-ask');
      ask.classList.add('gone');
    });
  }

  if (!motionOn()) return;

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = t => t * t * (3 - 2 * t);
  // Overshoot slightly at the end of the entrance, so it lands with some weight.
  const outBack = t => { const c = 1.22, c3 = c + 1; const u = t - 1; return 1 + c3 * u * u * u + c * u * u; };
  const outCubic = t => 1 - Math.pow(1 - t, 3);

  const INTRO_MS = 1000;

  /* ---------- the set of things that move ----------
     dx     : how far it drifts sideways while scrolling, px, signed
     dy     : parallax travel over the whole crossing, px
     zoom   : how much smaller it is at the edges of the screen than in the middle
     rot    : tilt at the edges, degrees, signed
     img    : how much the picture inside the frame zooms on top of that
     intro  : how far off the side it starts, px, signed. 0 = fade up in place
     delay  : stagger, ms
     sweep  : give it the action overlay
  */
  const items = [];
  function track(el, cfg) {
    if (!el) return null;
    const it = {
      el, cfg,
      varEl: cfg.varEl || el,
      cur: { tx: 0, ty: 0, sc: 1, rot: 0, img: 1, c: 0 },
      live: false, fresh: true, hover: 0,
      introAt: 0, introDone: !cfg.intro,
    };
    items.push(it);
    return it;
  }

  // Feature screenshots: the big ones, and the most room to play with. They come in from
  // the side the text is not on, which is what gives the page its left-right rock.
  document.querySelectorAll('.feature').forEach(f => {
    const dir = f.classList.contains('flip') ? -1 : 1;
    track(f.querySelector('.shot-frame'), {
      dx: 120 * dir, dy: -70, zoom: 0.11, rot: 2.6 * dir, img: 0.16,
      intro: dir, offscreen: true, cap: 820, sweep: true,
    });
    track(f.querySelector('.f-tag'), { dx: 44 * -dir, intro: 120 * -dir });
    track(f.querySelector('h2'), { dx: 26 * -dir, intro: 90 * -dir });
  });

  // Gallery cards. Alternating sides and a per-row stagger, so a row deals itself in.
  const cards = [...document.querySelectorAll('.gcard')];
  cards.forEach((g, i) => {
    const dir = i % 2 ? -1 : 1;
    track(g.querySelector('.shot-frame'), {
      dx: 78 * dir, dy: -44, zoom: 0.10, rot: 2.0 * dir, img: 0.13,
      intro: dir, offscreen: true, cap: 620, delay: (i % 3) * 110, varEl: g, sweep: true,
    });
  });

  // Short, large, not body copy: headings may move.
  document.querySelectorAll('.section-title, .final-card h2').forEach((h, i) => {
    track(h, { dx: 70 * (i % 2 ? -1 : 1), zoom: 0.05, intro: 180 * (i % 2 ? -1 : 1) });
  });

  // The flow strip reads left to right, so its labels fan out from the middle.
  const steps = [...document.querySelectorAll('.flow-step .lbl')];
  steps.forEach((s, i) => {
    const mid = (steps.length - 1) / 2;
    track(s, { dx: (i - mid) * 30, zoom: 0.08, intro: (i - mid) * 90, delay: i * 70 });
  });

  // Specs count in from alternating sides.
  document.querySelectorAll('.spec').forEach((s, i) => {
    track(s, { dx: 0, dy: -24, zoom: 0.14, intro: 150 * (i % 2 ? 1 : -1), delay: i * 90 });
  });

  const heroInner = document.querySelector('.hero-inner');

  /* ---------- the action overlay ---------- */
  for (const it of items) {
    if (!it.cfg.sweep) continue;
    const s = document.createElement('span');
    s.className = 'sweep';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<i class="sweep-beam"></i><i class="sweep-bar"></i>';
    // Stagger the loops so nine cards are not all scanning in lockstep.
    s.style.setProperty('--sweep-delay', `${(items.indexOf(it) % 5) * 0.9}s`);
    it.el.appendChild(s);
    it.sweep = s;
  }

  /* ---------- hover adds to the same transform instead of replacing it ---------- */
  document.querySelectorAll('.f-shot, .gcard').forEach(card => {
    const frame = card.querySelector('.shot-frame');
    const it = items.find(x => x.el === frame);
    if (!it) return;
    card.addEventListener('pointerenter', () => { it.hover = 1; });
    card.addEventListener('pointerleave', () => { it.hover = 0; });
  });

  /* ---------- who is close enough to bother with ---------- */
  let liveCount = 0;
  const near = new IntersectionObserver(entries => {
    for (const en of entries) {
      const it = items.find(x => x.el === en.target);
      if (!it || it.live === en.isIntersecting) continue;
      it.live = en.isIntersecting;
      // Snap to the right place the first time it wakes, rather than easing in from the
      // identity transform — which made an arriving card slide out and then come back.
      if (en.isIntersecting) it.fresh = true;
      liveCount += en.isIntersecting ? 1 : -1;
    }
    if (liveCount > 0 && !running) start();
  }, { rootMargin: '30% 0px 30% 0px' });

  function armIntro(it) {
    if (it.introAt || it.introDone) return;
    const k = it.cfg;
    if (k.offscreen) {
      // Measure the actual gap to the edge of the window, so the picture really does come
      // from outside the page rather than from a guessed number of pixels.
      const r = it.el.getBoundingClientRect();
      const d = k.intro > 0 ? innerWidth - r.left + 40 : -(r.right + 40);
      const cap = k.cap || 680;
      it.introDx = clamp(d, -cap, cap);
    } else {
      it.introDx = k.intro || 0;
    }
    it.introAt = performance.now() + (k.delay || 0);
    if (!running) start();
  }

  // A second, tighter observer starts the entrance only once the thing is really on screen,
  // and runs the action overlay only while it is.
  const shown = new IntersectionObserver(entries => {
    for (const en of entries) {
      const it = items.find(x => x.el === en.target);
      if (!it) continue;
      if (it.sweep) it.sweep.classList.toggle('on', en.isIntersecting);
      if (en.isIntersecting) armIntro(it);
    }
  }, { threshold: 0.12 });

  items.forEach(it => { near.observe(it.el); shown.observe(it.el); });

  /* ---------- the loop ---------- */
  let running = false, settleFrames = 0;

  // Sideways travel is a luxury of a wide screen: at phone width the same numbers would
  // shove a card past the edge of a single-column layout.
  let driftScale = 1;
  const measure = () => { driftScale = innerWidth < 760 ? 0.22 : innerWidth < 1100 ? 0.6 : 1; };
  measure();
  addEventListener('resize', measure);

  function frame(now) {
    const vh = innerHeight;
    let moving = false;

    for (const it of items) {
      // An entrance still in flight keeps its element awake even if `near` has not fired.
      const introLive = it.introAt && !it.introDone;
      if (!it.live && !introLive) continue;

      const r = it.el.getBoundingClientRect();
      // Belt and braces: anything hidden for an entrance that is plainly on screen gets
      // started here, whether or not the observer told us. Nothing may stay invisible.
      if (it.cfg.intro && !it.introDone && r.top < vh * 0.92 && r.bottom > vh * 0.06) armIntro(it);
      const p = clamp((vh - r.top) / (vh + r.height), 0, 1);
      const c = smooth(1 - Math.abs(p * 2 - 1));
      const away = 1 - c;
      const k = it.cfg;

      const tgt = {
        tx: (k.dx || 0) * away * driftScale,
        ty: (k.dy || 0) * (p - 0.5) * 2,
        sc: 1 - (k.zoom || 0) * away + it.hover * 0.025,
        rot: (k.rot || 0) * away,
        img: 1 + (k.img || 0) * away,
        c,
      };

      for (const key in tgt) {
        it.cur[key] = it.fresh ? tgt[key] : lerp(it.cur[key], tgt[key], 0.14);
        if (Math.abs(tgt[key] - it.cur[key]) > 0.0006) moving = true;
      }
      it.fresh = false;

      // The entrance rides on top of the travel transform, so the two never fight.
      let ix = 0, iy = 0, is = 1, io = 1;
      if (introLive) {
        const t = clamp((now - it.introAt) / INTRO_MS, 0, 1);
        const from = (it.introDx || 0) * driftScale;
        if (t <= 0) { ix = from; iy = 26; is = 0.9; io = 0; }
        else {
          ix = from * (1 - outBack(t));
          iy = 26 * (1 - outCubic(t));
          is = 0.9 + 0.1 * outCubic(t);
          io = Math.min(1, t * 2.1);
        }
        if (t >= 1) { it.introDone = true; it.el.style.opacity = ''; }
        moving = true;
      }

      const q = it.cur;
      it.el.style.transform =
        `translate3d(${(q.tx + ix).toFixed(2)}px,${(q.ty + iy).toFixed(2)}px,0) ` +
        `scale(${(q.sc * is).toFixed(4)}) rotate(${q.rot.toFixed(3)}deg)`;
      if (introLive) it.el.style.opacity = io.toFixed(3);
      if (k.img) it.el.style.setProperty('--imgsc', q.img.toFixed(4));
      it.varEl.style.setProperty('--c', q.c.toFixed(3));
    }

    if (heroInner) {
      const p = clamp(scrollY / innerHeight, 0, 1);
      heroInner.style.transform =
        `translate3d(0,${(p * -90).toFixed(1)}px,0) scale(${(1 - p * 0.1).toFixed(4)})`;
      heroInner.style.opacity = (1 - p * 0.9).toFixed(3);
    }

    // Keep spinning for a moment after everything settles, so the next scroll tick is
    // never waiting on a cold loop.
    settleFrames = moving ? 0 : settleFrames + 1;
    if (liveCount > 0 && settleFrames < 90 && !document.hidden) requestAnimationFrame(frame);
    else running = false;
  }

  function start() { running = true; settleFrames = 0; requestAnimationFrame(frame); }

  // Everything that has an entrance starts hidden, so it cannot be seen sitting in place
  // before it flies in.
  for (const it of items) if (it.cfg.intro) it.el.style.opacity = '0';

  const wake = () => { settleFrames = 0; if (!running) start(); };
  addEventListener('scroll', wake, { passive: true });
  addEventListener('resize', wake);
  addEventListener('visibilitychange', wake);
  start();
})();
