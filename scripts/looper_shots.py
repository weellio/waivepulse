"""Drive the Looper page with Playwright, load a few "sets" into the loop slots
(offline-rendered, no mic/gesture needed), fill the piano roll + notation, and
screenshot it for landing-page / video marketing shots.

    python scripts/looper_shots.py      # server must be running on :7861
"""
import os
from playwright.sync_api import sync_playwright

URL = "http://localhost:7861/looper"
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

JS = r"""
async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const note = (row, start, len) => { const a = []; for (let i = 0; i < len; i++) a.push([row, start + i]); return a; };
  const flat = (...g) => g.flat();
  const cells = () => document.querySelectorAll('#pianoRoll .proll-cell');
  const setOn = list => {
    const cs = cells();
    for (const [r, s] of list) {
      const c = cs[r * 16 + s];
      if (c && !c.classList.contains('on')) c.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    }
  };

  window.setSynthMode('roll');
  await sleep(200);

  // row index = 71 - midi (row 0 = B4 top ... row 23 = C3 bottom)
  const loopA = flat(note(23, 0, 4), note(20, 4, 4), note(18, 8, 4), note(21, 12, 4));
  const loopB = [[11,0],[11,1],[9,2],[9,3],[7,4],[7,5],[6,6],[6,7],[4,8],[4,9],[2,10],[2,11],[0,12],[0,13],[2,14],[2,15]];
  const loopC = flat(note(11,0,8), note(7,0,8), note(4,0,8), note(9,8,8), note(6,8,8), note(2,8,8));

  for (const pat of [loopA, loopB, loopC]) {
    setOn(pat);
    await window.pushPseqToLoop();
    await sleep(200);
    window.clearPseq();
    await sleep(80);
  }

  const display = flat(
    [[11,0],[11,1],[9,2],[9,3],[7,4],[7,5],[6,6],[6,7],[4,8],[4,9],[2,10],[2,11]],
    [[0,12],[2,13],[4,14],[6,15]],
    note(23,0,8), note(20,8,8),
  );
  setOn(display);
  await sleep(250);
  return document.querySelectorAll('#loopGrid .slot.playing, #loopGrid .slot.stopped').length;
}
"""

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 1920, "height": 1040}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_timeout(900)
    slots = page.evaluate(JS)
    page.wait_for_timeout(600)
    page.screenshot(path=os.path.join(OUT, "looper-full.png"))
    grid = page.query_selector("#loopGrid")
    if grid:
        grid.screenshot(path=os.path.join(OUT, "looper-loops.png"))
    sheet = page.query_selector(".sheet-wrap")
    if sheet:
        sheet.screenshot(path=os.path.join(OUT, "looper-notation.png"))
    print(f"done; filled slots reported: {slots}; console errors: {errs[:5] if errs else 'none'}")
    browser.close()
