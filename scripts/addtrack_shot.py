"""Screenshot the Add a Part panel for the README.

    WAIVEPULSE_URL=http://localhost:7899 python scripts/addtrack_shot.py

Needs the ACE-Step base model installed, or the panel shows the download notice instead of
the form (which is also worth a shot sometimes — pass --install to capture that state).
"""
import json
import os
import sys
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAIVEPULSE_URL", "http://localhost:7861")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

hist = json.load(urllib.request.urlopen(BASE + "/history", timeout=15))
job = next(r["job_id"] for r in hist if r.get("file"))

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1100, "height": 900}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/studio?job={job}", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(2500)
    page.click("#addtrk-btn")
    page.wait_for_selector("#addtrk-body", timeout=15000)
    page.wait_for_timeout(600)

    # fill the form in so the shot shows the feature in use, not an empty dialog
    if page.locator("#addtrk-desc").count():
        page.select_option("#addtrk-track", "strings")
        page.fill("#addtrk-desc", "warm sustained pad under the chorus")
        page.wait_for_timeout(250)

    page.locator("#addtrk-panel").screenshot(path=os.path.join(OUT, "addtrack.png"))
    print(f"modes: {page.locator('.addtrk-kind').count()}, "
          f"instruments: {page.locator('#addtrk-track option').count()}")
    print(f"console errors: {errs[:5] if errs else 'none'}")
    b.close()
