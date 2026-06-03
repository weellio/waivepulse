"""Verify the premade-beats bar: switch to the sequencer, load a preset, screenshot."""
import os
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    page = b.new_page(viewport={"width": 1920, "height": 1040}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto("http://localhost:7861/looper", wait_until="domcontentloaded")
    page.wait_for_timeout(700)
    page.evaluate("window.setDrumMode('seq')")
    page.wait_for_timeout(200)
    # how many preset buttons rendered?
    n = page.eval_on_selector_all("#beatPresets .beat-btn.preset", "els => els.map(e => e.textContent)")
    page.click("#beatPresets .beat-btn.preset >> text=Boom Bap")
    page.wait_for_timeout(300)
    lit = page.eval_on_selector_all("#seqGrid .seq-step.on", "els => els.length")
    sv = page.query_selector("#seqView")
    if sv:
        sv.screenshot(path=os.path.join(OUT, "beats-bar.png"))
    page.screenshot(path=os.path.join(OUT, "looper-beats-full.png"))
    print(f"preset buttons: {n}")
    print(f"cells lit after Boom Bap: {lit}")
    print(f"console errors: {errs[:5] if errs else 'none'}")
    b.close()
