"""Draw the multitrack-tape feature as a poster, for the landing page and the README.

The other gallery images are UI screenshots. This feature's screenshot is a wall of dark
findings text that shrinks to an unreadable grey block in a gallery card, so this draws the
*idea* instead: four tracks off one reel, each with the fault the checker found on it, and
the repaired version underneath with the manifest chip that proves the original is untouched.

Everything here is deterministic — the waveforms come from a seeded RNG, so re-running it
produces the same image and the diff stays empty unless the design actually changed.

    python scripts/tape_poster.py
"""
import math
import os
import random

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 1400, 820

AMBER = "#fbbf24"
RED = "#f87171"
GREEN = "#4ade80"
CYAN = "#8cffff"


def envelope(n, seed, *, busy=1.0):
    """A plausible song envelope: slow sections, a build, and per-sample grit."""
    rng = random.Random(seed)
    out = []
    for i in range(n):
        t = i / (n - 1)
        # three slow sections, so the track reads as music rather than noise
        body = 0.55 + 0.35 * math.sin(t * math.pi * 2.3 + seed) + 0.18 * math.sin(t * math.pi * 7.1)
        body *= 0.72 + 0.5 * math.sin(t * math.pi)          # fade in and out
        grit = rng.uniform(0.55, 1.0) ** (1.0 / busy)
        out.append(max(0.05, min(1.0, body * grit)))
    return out


def wave_path(amps, w, h, *, dc=0.0):
    """Mirrored waveform as one filled path. dc shifts the centreline, as DC offset does."""
    n = len(amps)
    mid = h / 2 * (1 - dc)
    top = [f"{i * w / (n - 1):.1f},{mid - a * (h / 2) * 0.94:.1f}" for i, a in enumerate(amps)]
    bot = [f"{i * w / (n - 1):.1f},{mid + a * (h / 2) * 0.94:.1f}" for i, a in reversed(list(enumerate(amps)))]
    return "M" + " L".join(top) + " L" + " L".join(bot) + " Z"


def lane_svg(amps, *, w=760, h=74, color=AMBER, dc=0.0, bands=(), spikes=()):
    """One track lane: coloured fault bands behind, the waveform in front."""
    parts = [f'<svg viewBox="0 0 {w} {h}" width="{w}" height="{h}" preserveAspectRatio="none">']
    for start, end, col in bands:
        x, bw = start * w, (end - start) * w
        # A wash plus two edge lines. A solid block just looked like a dark rectangle
        # painted over the track; the edges are what make it read as missing signal.
        parts.append(f'<rect x="{x:.1f}" y="0" width="{bw:.1f}" height="{h}" fill="{col}" opacity=".10"/>')
        parts.append(f'<path d="M{x:.1f} 0 V{h} M{x + bw:.1f} 0 V{h}" stroke="{col}" '
                     f'stroke-width="1.6" stroke-dasharray="4 4" opacity=".85"/>')
    parts.append(f'<path d="{wave_path(amps, w, h, dc=dc)}" fill="{color}" opacity=".92"/>')
    for pos in spikes:
        parts.append(f'<rect x="{pos * w:.1f}" y="2" width="2.5" height="{h - 4}" fill="{RED}"/>')
    parts.append("</svg>")
    return "".join(parts)


def pill(text, col):
    return f'<span class="pill" style="--c:{col}">{text}</span>'


# ── the four tracks of the demo reel ─────────────────────────────────────────
bass = envelope(300, 3)
guitar = envelope(300, 11)
keys = [a * 0.82 for a in envelope(300, 19)]
vocal = envelope(300, 29)
for i in range(300):                      # the dropout the checker finds at 4.7 s
    if 148 <= i <= 163:
        vocal[i] *= 0.06

TRACKS = [
    ("01", "bass.wav", bass, AMBER, 0.22, (), (),
     [("DC offset +0.028", AMBER)]),
    ("02", "guitar.wav", guitar, AMBER, 0.0, (), (),
     [("50 Hz hum at −44.8 dBFS", RED), ("hiss −34.6", AMBER)]),
    ("03", "keys.wav", keys, "#b98a2e", 0.0, (), (),
     [("19 dB duller — head azimuth", AMBER)]),
    ("04", "vocal.wav", vocal, AMBER, 0.0, ((0.49, 0.545, RED),), (),
     [("dropout at 4.7 s", RED), ("−90 ms out of line", RED)]),
]

lanes = []
for num, name, amps, col, dc, bands, spikes, pills in TRACKS:
    lanes.append(f"""
      <div class="lane">
        <div class="lane-id"><b>{num}</b><span>{name}</span></div>
        <div class="lane-wave">{lane_svg(amps, w=620, h=68, color=col, dc=dc, bands=bands, spikes=spikes)}</div>
        <div class="lane-pills">{''.join(pill(t, c) for t, c in pills)}</div>
      </div>""")

# ── the before / after strip ─────────────────────────────────────────────────
dirty = envelope(220, 7)
clean = list(dirty)
clicks = [0.17, 0.41, 0.63, 0.86]
before = lane_svg(dirty, w=330, h=56, color="#8a8a96", spikes=clicks)
after = lane_svg(clean, w=330, h=56, color=GREEN)

HTML = f"""<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  body{{width:{W}px;height:{H}px;background:#07070b;font-family:Inter,system-ui,sans-serif;color:#e7e7ee}}
  .poster{{width:{W}px;height:{H}px;padding:44px 52px;position:relative;overflow:hidden;
    background:radial-gradient(1200px 620px at 18% -10%,rgba(251,191,36,.16),transparent 62%),
               radial-gradient(900px 520px at 92% 108%,rgba(74,222,128,.12),transparent 60%),
               #07070b}}
  .poster::after{{content:"";position:absolute;inset:0;pointer-events:none;
    background:repeating-linear-gradient(0deg,rgba(255,255,255,.022) 0 1px,transparent 1px 3px)}}
  header{{display:flex;align-items:flex-start;gap:26px;margin-bottom:28px}}
  .reels{{flex:none}}
  .eyebrow{{font-family:'Space Grotesk';font-size:13px;font-weight:700;letter-spacing:.22em;
    text-transform:uppercase;color:{AMBER};margin-bottom:8px}}
  h1{{font-family:'Space Grotesk';font-size:39px;font-weight:700;letter-spacing:-.02em;line-height:1.02}}
  .sub{{color:#9a9aa8;font-size:16px;margin-top:9px}}
  .chips{{margin-left:auto;display:flex;flex-direction:column;align-items:flex-end;gap:8px}}
  .chip{{font-family:'Space Grotesk';font-size:13px;font-weight:600;letter-spacing:.04em;
    color:#c9c9d4;border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 14px;
    background:rgba(255,255,255,.03)}}
  .lanes{{display:flex;flex-direction:column;gap:12px}}
  .lane{{display:grid;grid-template-columns:116px 1fr 318px;gap:20px;align-items:center;
    background:rgba(255,255,255,.028);border:1px solid rgba(255,255,255,.07);
    border-radius:14px;padding:14px 18px}}
  .lane-id{{display:flex;flex-direction:column;line-height:1.15}}
  .lane-id b{{font-family:'Space Grotesk';font-size:25px;color:{AMBER};letter-spacing:-.01em}}
  .lane-id span{{font-size:13px;color:#7b7b88;letter-spacing:.02em}}
  .lane-wave{{height:68px}}
  .lane-wave svg{{width:100%;height:68px;display:block}}
  .lane-pills{{display:flex;flex-direction:column;align-items:flex-start;gap:7px}}
  .pill{{font-size:13.5px;font-weight:600;color:var(--c);border:1px solid color-mix(in srgb,var(--c) 42%,transparent);
    background:color-mix(in srgb,var(--c) 11%,transparent);border-radius:999px;padding:4px 13px}}
  .pill::before{{content:"●";font-size:8px;vertical-align:middle;margin-right:7px}}
  footer{{margin-top:26px;display:grid;grid-template-columns:1fr 1fr auto;gap:26px;align-items:center;
    border-top:1px solid rgba(255,255,255,.09);padding-top:24px}}
  .ba h4{{font-family:'Space Grotesk';font-size:12.5px;font-weight:700;letter-spacing:.18em;
    text-transform:uppercase;margin-bottom:9px}}
  .ba.b h4{{color:#8a8a96}} .ba.a h4{{color:{GREEN}}}
  .ba svg{{width:100%;height:56px;display:block}}
  .verdict{{text-align:right;max-width:330px}}
  .verdict .ok{{font-family:'Space Grotesk';font-size:19px;font-weight:700;color:{GREEN};
    display:flex;align-items:center;gap:10px;justify-content:flex-end}}
  .verdict p{{font-size:13.5px;color:#8f8f9c;margin-top:7px;line-height:1.5}}
</style></head><body>
<div class="poster">
  <header>
    <svg class="reels" width="108" height="108" viewBox="0 0 108 108" fill="none">
      <circle cx="30" cy="54" r="26" stroke="{AMBER}" stroke-width="2.5" opacity=".9"/>
      <circle cx="30" cy="54" r="8"  stroke="{AMBER}" stroke-width="2.5" opacity=".6"/>
      <circle cx="84" cy="54" r="17" stroke="{AMBER}" stroke-width="2.5" opacity=".9"/>
      <circle cx="84" cy="54" r="6"  stroke="{AMBER}" stroke-width="2.5" opacity=".6"/>
      <path d="M30 28 H84" stroke="{AMBER}" stroke-width="2.5" opacity=".45"/>
      <path d="M30 80 H84" stroke="{AMBER}" stroke-width="2.5" opacity=".45"/>
      <path d="M8 54 h8 M100 54 h-8" stroke="{AMBER}" stroke-width="2" opacity=".35"/>
    </svg>
    <div>
      <div class="eyebrow">Multitrack tape session</div>
      <h1>Four tracks off one reel,<br>and what the tape did to them.</h1>
      <div class="sub">Demo reel 3 &middot; spring 1987 &middot; Tascam 38 &middot; 1/2 inch at 15 ips</div>
    </div>
    <div class="chips">
      <span class="chip">4 tracks</span>
      <span class="chip">96 kHz &middot; 24-bit</span>
      <span class="chip">6 findings</span>
    </div>
  </header>

  <div class="lanes">{''.join(lanes)}</div>

  <footer>
    <div class="ba b"><h4>Before &middot; four clicks</h4>{before}</div>
    <div class="ba a"><h4>After &middot; repaired copy</h4>{after}</div>
    <div class="verdict">
      <div class="ok"><span>&#10003;</span> Manifest written</div>
      <p>An MD5 per track, over the audio samples only &mdash; so tagging it later does not
         break the proof. Your transfer is never written to.</p>
    </div>
  </footer>
</div>
</body></html>"""

out_landing = os.path.join(ROOT, "landing", "img", "feat-tape.png")
out_assets = os.path.join(ROOT, "assets", "tape-poster.png")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
    page.set_content(HTML, wait_until="load")
    page.wait_for_timeout(1200)          # webfonts
    page.locator(".poster").screenshot(path=out_landing)
    b.close()

import shutil
shutil.copyfile(out_landing, out_assets)
for f in (out_landing, out_assets):
    print(f"{f}  {os.path.getsize(f):,} bytes")
