"""Screenshot the Pronunciation panel for the README and the landing page.

Waits for the dictionary to finish loading — the panel refuses to run without it, so a shot
taken too early captures only "the pronunciation dictionary is still loading".

    WAIVEPULSE_URL=http://localhost:7899 python scripts/pronounce_shot.py
"""
import os

from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAIVEPULSE_URL", "http://localhost:7861")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

# one of each kind the scanner knows: heteronym, number, acronym, unknown
LYRICS = """[Verse]
I read the letter twice in 1999
The bass was low and Aoife kept the time
A minute more and KTLA would close
"""

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1180, "height": 1150}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/lyrics", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function(
        "() => /dictionary loaded/i.test(document.getElementById('dictState').textContent)",
        timeout=30000)

    page.fill("#output", LYRICS)
    page.click("#btnPronounce")
    page.wait_for_selector("#pronResults .pr-row", timeout=15000)
    page.wait_for_timeout(500)

    panel = page.locator(".rhyme-finder").last
    panel.scroll_into_view_if_needed()
    panel.screenshot(path=os.path.join(OUT, "pronounce.png"))

    # The full panel is portrait (about 1:2) because each flagged word stacks, and the landing
    # page's gallery strip can hand a card as little as 240px of width. Anything denser than
    # one row is illegible at that size, so cut exactly the count line plus the first word.
    head = page.locator("#pronResults .pr-head").bounding_box()
    first = page.locator("#pronResults .pr-row").first.bounding_box()
    panel_box = panel.bounding_box()
    if head and first and panel_box:
        page.screenshot(path=os.path.join(OUT, "pronounce-wide.png"), clip={
            "x": panel_box["x"], "y": head["y"] - 4, "width": panel_box["width"],
            "height": (first["y"] + first["height"]) - head["y"] + 8,
        })
    print(f"flagged: {page.locator('#pronResults .pr-row').count()} words")
    print(f"options: {page.locator('#pronResults .pr-opt').count()} suggestions")
    print(f"console errors: {errs[:5] if errs else 'none'}")
    b.close()
