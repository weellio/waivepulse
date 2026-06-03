"""Verify the melody presets live with the ROLL: switch to Roll, confirm the preset
bar is visible there, load one, screenshot."""
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

    # presets must NOT be visible in Keys mode (they belong to the roll now)
    vis_keys = page.is_visible("#rollPresets")
    page.evaluate("window.setSynthMode('roll')")
    page.wait_for_timeout(300)
    vis_roll = page.is_visible("#rollPresets")

    names = page.eval_on_selector_all("#rollPresets .beat-btn.preset", "els => els.map(e => e.textContent)")
    page.click("#rollPresets .beat-btn.preset >> text=Jazz ii7–V7–I")
    page.wait_for_timeout(300)
    heads = page.eval_on_selector_all("#sheetMusic .sm-note", "els => els.length")
    page.screenshot(path=os.path.join(OUT, "melody-roll-full.png"))
    print(f"presets: {names}")
    print(f"#rollPresets visible in Keys mode: {vis_keys} (want False)")
    print(f"#rollPresets visible in Roll mode: {vis_roll} (want True)")
    print(f"noteheads after Jazz progression: {heads}")
    print(f"console errors: {errs[:5] if errs else 'none'}")
    b.close()
