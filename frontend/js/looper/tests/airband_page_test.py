"""Browser test for the Looper's Air Band (webcam hands -> drums / keys).

Serve frontend/ first, e.g.
    cd frontend && python -m http.server 7883
then
    python frontend/js/looper/tests/airband_page_test.py [base_url] [out_dir] [--fake-cam]

Checks: the panel renders (zone editor built from the saved / preset layout); the
Camera button starts the webcam + hand tracker and frames flow (fps > 0); synthetic
hand landmarks fed through window.__airband.feed make a strike hit the Kick pad and
an open hand hold / release a synth note (through the real noteOn path); layout
switching and the Big view work; no console errors. Screenshots go to out_dir.
--fake-cam uses Chromium's synthetic camera instead of a real device.
"""
import asyncio
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8')   # Windows console: status text carries em-dashes / emoji
except Exception:
    pass
from pathlib import Path

from playwright.async_api import async_playwright

args = [a for a in sys.argv[1:] if not a.startswith('--')]
FAKE = '--fake-cam' in sys.argv
BASE = args[0] if len(args) > 0 else 'http://127.0.0.1:7883'
OUT = Path(args[1] if len(args) > 1 else Path(__file__).parent / 'out')
OUT.mkdir(parents=True, exist_ok=True)
URL = BASE.rstrip('/') + '/looper.html'

# Same synthetic hand as airband.test.mjs (palm centre ≈ (cx, cy + size/5)).
HAND_JS = """(o) => {
  const { cx = 0.5, cy = 0.5, size = 0.1, open = true } = o;
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[0] = { x: cx, y: cy + size, z: 0 };
  const mcpX = [cx - 0.45 * size, cx - 0.15 * size, cx + 0.15 * size, cx + 0.45 * size];
  [5, 9, 13, 17].forEach((i, k) => { lm[i] = { x: mcpX[k], y: cy, z: 0 }; });
  [[6, 7, 8], [10, 11, 12], [14, 15, 16], [18, 19, 20]].forEach(([pip, dip, tip], k) => {
    lm[pip] = { x: mcpX[k], y: cy - 0.5 * size, z: 0 };
    if (open) { lm[dip] = { x: mcpX[k], y: cy - 0.8 * size, z: 0 }; lm[tip] = { x: mcpX[k], y: cy - 1.1 * size, z: 0 }; }
    else      { lm[dip] = { x: mcpX[k], y: cy - 0.2 * size, z: 0 }; lm[tip] = { x: mcpX[k], y: cy + 0.3 * size, z: 0 }; }
  });
  lm[1] = { x: cx - 0.6 * size, y: cy + 0.6 * size, z: 0 }; lm[2] = { x: cx - 0.8 * size, y: cy + 0.3 * size, z: 0 };
  lm[3] = { x: cx - 0.9 * size, y: cy, z: 0 }; lm[4] = { x: cx - 1.0 * size, y: cy - 0.3 * size, z: 0 };
  return lm;
}"""


async def main():
    errors, warnings = [], []
    async with async_playwright() as p:
        flags = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
                 '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
        if FAKE:
            flags.append('--use-fake-device-for-media-stream')
        browser = await p.chromium.launch(headless=True, args=flags)
        ctx = await browser.new_context(viewport={'width': 1600, 'height': 1000}, permissions=['camera'])
        page = await ctx.new_page()
        page.on('console', lambda m: errors.append(m.text + ' @ ' + (m.location or {}).get('url', '')) if m.type == 'error' else (warnings.append(m.text) if m.type == 'warning' else None))
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(URL, wait_until='networkidle')
        await page.wait_for_function('!!window.__airband && !!window.__looper')

        # 1) panel + zone editor
        n_zones = await page.locator('#airZones select').count()
        preset = await page.input_value('#airPreset')
        grid = await page.input_value('#airGrid')
        print(f'panel: preset={preset} grid={grid} zones={n_zones}')
        assert n_zones == 8 and grid == '2x4', 'default drum kit layout = 2x4 = 8 zone selects'
        await page.locator('#airBand').screenshot(path=str(OUT / 'airband_panel.png'))

        # 2) camera + tracker (real device unless --fake-cam)
        await page.click('#airConnBtn')
        try:
            await page.wait_for_function("document.getElementById('airStat').className.includes('ok')", timeout=90_000)
        except Exception:
            stat = await page.text_content('#airStat')
            raise SystemExit(f'camera/tracker did not start: {stat!r}')
        # headless Chromium may run requestAnimationFrame at only a few Hz: wait for the first counted second
        await page.wait_for_function('window.__airband.A.fps > 0', timeout=20_000)
        fps = await page.evaluate('window.__airband.A.fps')
        hands = await page.evaluate('window.__airband.A.handsNow')
        vw = await page.evaluate("document.getElementById('airVideo').videoWidth + 'x' + document.getElementById('airVideo').videoHeight")
        stat = await page.text_content('#airStat')
        print(f'camera: {vw} fps={fps} hands_now={hands} stat={stat!r}')
        assert fps > 0, 'tracker frames must flow'
        await page.locator('#airStage').screenshot(path=str(OUT / 'airband_live.png'))

        # 3) synthetic strike in the Kick zone (drum kit: zone 4 = bottom-left)
        await page.evaluate("window.__airband.A.log.length = 0")
        strike = """async (handJs) => {
          const hand = eval(handJs); const A = window.__airband;
          let t = performance.now() + 100000;                 // future timestamps: never collide with camera frames
          for (const cy of [0.55, 0.62, 0.69, 0.76, 0.83, 0.84, 0.84]) { A.feed([{ label: 'Right', landmarks: hand({ cx: 0.9, cy, open: false }) }], t); t += 33; }
          A.feed([], t);
          return A.A.log.filter(e => e.type === 'hit');
        }"""
        hits = await page.evaluate(strike, HAND_JS)
        print('strike ->', hits)
        # mirror is ON by default: x=0.9 in camera space → 0.1 on screen → column 0 → Kick
        assert len(hits) == 1 and hits[0]['name'] == 'Kick', 'one Kick hit expected'
        assert 0.35 <= hits[0]['vel'] <= 1

        # 4) notes: Band layout, open hand in the root zone holds a synth voice; fist releases
        await page.select_option('#airPreset', 'band')
        note = """async (handJs) => {
          const hand = eval(handJs); const A = window.__airband, S = window.__looper.S;
          const t = performance.now() + 200000;
          A.feed([{ label: 'Left', landmarks: hand({ cx: 0.38, cy: 0.7, open: true }) }], t);   // mirrored → x 0.62 → zone 6 (root)
          const held = Object.keys(S.activeOsc).filter(k => k.startsWith('air_'));
          A.feed([{ label: 'Left', landmarks: hand({ cx: 0.38, cy: 0.7, open: false }) }], t + 33);
          const after = Object.keys(S.activeOsc).filter(k => k.startsWith('air_'));
          return { held, after, log: A.A.log.slice(-3) };
        }"""
        r = await page.evaluate(note, HAND_JS)
        print('note ->', r)
        assert r['held'] == ['air_Left_60'], 'open hand in the root zone holds C4 (midi 60)'
        assert r['after'] == [], 'fist releases it'

        # 5) custom assignment persists + Big view renders
        await page.select_option('#airZones select >> nth=0', 'n:4')
        saved = await page.evaluate("JSON.parse(localStorage.getItem('wp.looper.airband'))")
        assert saved['preset'] == 'custom' and '"deg":4' in saved['m'], 'zone edit saved as custom'
        await page.click('#airBigBtn')
        await page.wait_for_timeout(400)
        big = await page.evaluate("document.getElementById('airStage').classList.contains('big')")
        assert big
        await page.screenshot(path=str(OUT / 'airband_big.png'))
        await page.keyboard.press('Escape')
        assert not await page.evaluate("document.getElementById('airStage').classList.contains('big')")

        # 6) stop releases the camera
        await page.click('#airConnBtn')
        await page.wait_for_timeout(300)
        on = await page.evaluate('window.__airband.A.on')
        assert not on
        await page.screenshot(path=str(OUT / 'airband_page.png'))
        await browser.close()

    bad = [e for e in errors if 'favicon' not in e and '/assets/' not in e]   # /assets (favicon) lives outside frontend/ on the plain static server
    print('console errors:', bad)
    print('console warnings:', warnings[:5])
    assert not bad, 'no console errors'
    print('AIR BAND PAGE TEST PASSED')


asyncio.run(main())
