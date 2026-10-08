"""Screenshot the Song Check panel for the README and the landing page.

Expands a real song card (Library cards start collapsed — a button inside one still reports
visible to Playwright, so clicking without expanding captures nothing), runs the check, and
shoots the panel.

Pick a song that actually has findings AND a Demucs separation, so the instrumental-dropout
row appears: that row is the one no cloud generator can show you.

    WAIVEPULSE_URL=http://localhost:7899 python scripts/songcheck_shot.py [job_id]
"""
import os
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAIVEPULSE_URL", "http://localhost:7861")
JOB = sys.argv[1] if len(sys.argv) > 1 else None
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1180, "height": 1000}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector(".job-card", timeout=20000)
    page.wait_for_timeout(1500)

    card = page.locator(f"#job-{JOB}") if JOB else page.locator(".job-card").first
    card_id = card.get_attribute("id")
    card.locator(".job-head, .job-title, .card-head").first.click()
    page.wait_for_function(
        """id => {
             const c = document.getElementById(id);
             const b = c && c.querySelector('.job-body');
             return b && getComputedStyle(b).gridTemplateRows !== '10px';
           }""", arg=card_id, timeout=15000)

    card.locator("button:has-text('Check')").first.click()
    page.wait_for_selector(f"#{card_id} .songcheck-panel .sc-sub", timeout=180000)
    page.wait_for_timeout(700)

    panel = page.locator(f"#{card_id} .songcheck-panel")
    panel.scroll_into_view_if_needed()
    panel.screenshot(path=os.path.join(OUT, "songcheck.png"))
    print(f"card: {card_id}")
    print(f"findings: {panel.locator('.sc-item').count()}")
    print(panel.inner_text()[:400].encode("ascii", "replace").decode())
    print(f"console errors: {errs[:5] if errs else 'none'}")
    b.close()
