import os, pathlib
from playwright.sync_api import sync_playwright

url = pathlib.Path("landing/_preview.html").resolve().as_uri()
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1200, "height": 1500}, device_scale_factor=1)
    pg.goto(url, wait_until="networkidle")
    pg.wait_for_timeout(400)
    sizes = pg.eval_on_selector_all(
        ".gcard .shot-frame img",
        "els => els.map(e => ({w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height)}))",
    )
    pg.screenshot(path="scripts/shots/gallery-preview.png", full_page=True)
    print("rendered image sizes:", sizes)
    b.close()
