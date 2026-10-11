"""Screenshot the Rewrite Section panel for the README and the landing page.

The panel refuses to generate without a ruler selection, so this makes one first — a shot of
the disabled state would show the warning rather than the feature.

    WAIVEPULSE_URL=http://localhost:7899 python scripts/repaint_shot.py
"""
import json
import os
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAIVEPULSE_URL", "http://localhost:7861")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

hist = json.load(urllib.request.urlopen(BASE + "/history", timeout=15))
job = next(r["job_id"] for r in hist if r.get("file"))

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1180, "height": 980}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/studio?job={job}", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(3000)

    # Make a real selection the way the panel tells you to: "press [ and ] at two playhead
    # positions". Setting window.S directly does nothing — the modules keep their own state
    # object and do not publish it, so the panel still reads "No region selected".
    page.keyboard.press("Home")
    for _ in range(12):
        page.keyboard.press("ArrowRight")      # 2 s a press
    page.keyboard.press("[")
    for _ in range(6):
        page.keyboard.press("ArrowRight")
    page.keyboard.press("]")
    page.wait_for_timeout(400)
    page.click("#ace-btn")
    page.wait_for_selector("#ace-panel", timeout=15000)
    page.wait_for_timeout(900)

    desc = page.locator("#ace-desc")
    if desc.count() and desc.is_visible():
        desc.fill("same groove, but strings take the lead instead of the guitar")
        page.wait_for_timeout(300)

    page.locator("#ace-panel").screenshot(path=os.path.join(OUT, "repaint.png"))
    print(f"console errors: {errs[:4] if errs else 'none'}")
    b.close()
