"""Verify the Generate-page 'Details' modal populates. Calls window.openDetails()
directly with a real done-job id (cards are collapsed by default)."""
import os
from playwright.sync_api import sync_playwright

OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 900}, device_scale_factor=1)
    errs = []
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto("http://localhost:7861/", wait_until="networkidle")
    pg.wait_for_timeout(800)
    jid = pg.evaluate(
        "async () => { const a = await (await fetch('/history')).json();"
        " const d = a.find(j => j.status === 'done'); return d ? d.job_id : null; }"
    )
    if not jid:
        print("no done job to inspect"); b.close(); raise SystemExit
    pg.evaluate(f"window.openDetails('{jid}')")
    pg.wait_for_timeout(400)
    info = pg.evaluate(
        "() => ({ visible: getComputedStyle(document.getElementById('details-modal')).display,"
        " title: document.getElementById('dm-title').value,"
        " artist: document.getElementById('dm-artist').value,"
        " rows: document.querySelectorAll('#dm-settings .k').length,"
        " lyr: (document.getElementById('dm-lyrics').textContent||'').slice(0,30) })"
    )
    pg.screenshot(path=os.path.join(OUT, "details-modal.png"))
    print("job:", jid)
    print("modal:", info)
    print("console errors:", errs[:5] if errs else "none")
    b.close()
