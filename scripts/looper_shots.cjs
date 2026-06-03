// Drives the Looper page with Playwright, loads a few "sets" into the loop slots
// (offline-rendered, so no mic/gesture needed), fills the piano roll + notation, and
// screenshots it — for landing-page / video marketing shots.
//   NODE_PATH=<global node_modules> PLAYWRIGHT_BROWSERS_PATH=<cache> node scripts/looper_shots.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://localhost:7861/looper';
const OUT = path.join(__dirname, 'shots');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1040 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  const result = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const note = (row, start, len) => { const a = []; for (let i = 0; i < len; i++) a.push([row, start + i]); return a; };
    const flat = (...groups) => groups.flat();
    const cells = () => document.querySelectorAll('#pianoRoll .proll-cell');
    const setOn = list => {                       // toggle the given [row,step] cells ON
      const cs = cells();
      for (const [r, s] of list) {
        const c = cs[r * 16 + s];
        if (c && !c.classList.contains('on')) c.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      }
    };

    window.setSynthMode('roll');
    await sleep(200);

    // row index = 71 - midi (row 0 = B4 top … row 23 = C3 bottom)
    const loopA = flat(note(23, 0, 4), note(20, 4, 4), note(18, 8, 4), note(21, 12, 4));                 // walking bass, quarters
    const loopB = [[11, 0], [11, 1], [9, 2], [9, 3], [7, 4], [7, 5], [6, 6], [6, 7],                      // rising arp, 8ths
                   [4, 8], [4, 9], [2, 10], [2, 11], [0, 12], [0, 13], [2, 14], [2, 15]];
    const loopC = flat(note(11, 0, 8), note(7, 0, 8), note(4, 0, 8), note(9, 8, 8), note(6, 8, 8), note(2, 8, 8)); // two triads, halves

    for (const pat of [loopA, loopB, loopC]) {
      setOn(pat);
      await window.pushPseqToLoop();              // renders to next empty slot (offline)
      await sleep(200);
      window.clearPseq();
      await sleep(80);
    }

    // Leave a rich pattern in the roll for the notation read-out (both staves populated)
    const display = flat(
      [[11, 0], [11, 1], [9, 2], [9, 3], [7, 4], [7, 5], [6, 6], [6, 7], [4, 8], [4, 9], [2, 10], [2, 11]], // treble 8th run
      [[0, 12], [2, 13], [4, 14], [6, 15]],                                                                 // four 16ths (double beam)
      note(23, 0, 8), note(20, 8, 8),                                                                       // bass half notes
    );
    setOn(display);
    await sleep(250);
    return { slots: window.__loopCount ?? document.querySelectorAll('#loopGrid .slot.playing, #loopGrid .slot.stopped').length };
  });

  await page.waitForTimeout(500);

  await page.screenshot({ path: path.join(OUT, 'looper-full.png'), fullPage: false });
  const grid = await page.$('#loopGrid');     if (grid) await grid.screenshot({ path: path.join(OUT, 'looper-loops.png') });
  const sheet = await page.$('.sheet-wrap');  if (sheet) await sheet.screenshot({ path: path.join(OUT, 'looper-notation.png') });

  console.log('done; console errors:', errs.length ? errs.slice(0, 5) : 'none');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
