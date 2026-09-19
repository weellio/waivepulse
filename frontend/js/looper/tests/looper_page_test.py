"""End-to-end browser test for the Looper's project save/open, MIDI import,
loudness/MP3 export and pattern banks + chain.

Serve frontend/ first (any static server), e.g.
    cd frontend && python -m http.server 7883
then
    python frontend/js/looper/tests/looper_page_test.py [base_url] [out_dir]

Checks: save .wploop -> reload -> open -> identical state; ⬇ MIDI -> Import MIDI
-> same banks; MP3 export starts with an MPEG frame header (FF FB) and its
LUFS (read-out AND re-measured after decoding) is within ±0.5 of the target;
chain plays banks in order; queued bank switch lands on the bar; no console
errors. Screenshots at 1366 and 1920 wide go to out_dir.
"""
import asyncio
import base64
import json
import subprocess
import sys
from pathlib import Path

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:7883'
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).parent / 'out')
OUT.mkdir(parents=True, exist_ok=True)
URL = BASE.rstrip('/') + '/looper.html'

SNAP_JS = """() => {
  const L = window.__looper, S = L.S;
  const p = L.collectProject(); delete p.savedAt;
  const sum = b => { let t = 0; for (let c = 0; c < b.numberOfChannels; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) t += Math.abs(d[i]) * ((i % 7) + 1); } return t; };
  p.loopHashes = S.slots.map(s => s.buffer ? [s.buffer.length, s.buffer.sampleRate, sum(s.buffer), s._trimOrig ? sum(s._trimOrig) : 0, s.state] : null);
  p.eqLive = S.slots.map(s => s.eq ? s.eq.filters.map(f => +f.gain.value.toFixed(3)) : null);
  p.gainLive = S.slots.map(s => s.gainNode ? +s.gainNode.gain.value.toFixed(3) : null);
  p.master = { len: S.masterLen, slot: S.masterSlot };
  const t = id => document.getElementById(id)?.textContent;
  const v = id => document.getElementById(id)?.value;
  p.dom = { bpm: t('bpmVal'), swing: t('swingVal'), human: t('humanVal'), count: t('countInVal'), oct: t('octDisplay'),
            atk: t('atkVal'), cut: t('cutVal'), rev: t('revVal'), mvol: t('masterVolVal'), tr: t('trVal'),
            name: v('projName'), chain: v('chainInput'), scale: v('scaleSel'), root: v('scaleRoot'),
            fmt: v('expFmt'), target: v('expTarget'), songFmt: v('song-fmt'), songTarget: v('song-target'),
            quant: document.getElementById('quantBtn').classList.contains('on'),
            chainOn: document.getElementById('chainBtn').classList.contains('on'),
            bankOn: [...document.querySelectorAll('.bank-btn.on')].map(b => b.textContent).join(''),
            cellsOn: document.querySelectorAll('#seqGrid .seq-step.on').length,
            rollOn: document.querySelectorAll('#pianoRoll .proll-cell.on').length,
            durs: [0,1,2,3,4,5].map(i => t('dur-' + i)), nudges: [0,1,2,3,4,5].map(i => t('nudge-' + i)),
            vols: [0,1,2,3,4,5].map(i => v('vol-' + i)) };
  return JSON.stringify(p);
}"""

BUILD_JS = """async () => {
  const S = window.__looper.S;
  const D = await import('/js/looper/drums.js');
  const P = await import('/js/looper/pianoseq.js');
  const EQ = await import('/js/shared/eq7.js');
  const T = await import('/js/looper/looptrim.js');
  const g = (r, c, v = 0) => Array.from({ length: r }, () => new Array(c).fill(v));
  window.setProjectName('Test Song'); document.getElementById('projName').value = 'Test Song';
  window.chBPM(-20);                     // 100 BPM
  window.setSwing(30); window.chCountIn(1);
  window.toggleQuantize();
  window.setDrumMode('seq');
  // bank A: four-floor + snare (50% chance on 12) + hats with a ratchet
  const a = g(8, 16), ap = g(8, 16, 1), ar = g(8, 16, 1);
  [0, 4, 8, 12].forEach(s => a[0][s] = 1);
  a[1][4] = 0.9; a[1][12] = 0.9; ap[1][12] = 0.5;
  for (let s = 0; s < 16; s += 2) a[2][s] = 0.62;
  ar[2][14] = 3; a[2][15] = 0.4;
  D.applySeqPattern(a, ap, ar);
  const ra = g(24, 16); [11, 7, 4].forEach(r => { for (let s = 0; s < 4; s++) ra[r][s] = 1; });   // C E G held
  ra[9][8] = 1; ra[9][9] = 1; ra[2][12] = 1;
  P.applyPseqPattern(ra);
  window.clickBank(1);                  // bank B: half-time + a melody
  const b = g(8, 16); b[0][0] = 1; b[0][10] = 0.85; b[1][8] = 1; b[6][0] = 0.95;
  const br = g(8, 16, 1); br[1][8] = 2;
  D.applySeqPattern(b, null, br);
  const rb = g(24, 16); [[16, 0, 2], [14, 2, 2], [12, 4, 4], [11, 8, 8]].forEach(([r, s, l]) => { for (let i = 0; i < l; i++) rb[r][s + i] = 1; });
  P.applyPseqPattern(rb);
  window.clickBank(0);
  window.setChainStr('A B'); document.getElementById('chainInput').value = 'A B';
  window.toggleChain();
  // synth
  window.setSynthMode('roll');
  document.getElementById('atkSlider').value = 40; document.getElementById('relSlider').value = 900; window.setADSR();
  document.getElementById('cutSlider').value = 5200; document.getElementById('resSlider').value = 3.2; window.setFilter();
  window.setArpRate(2, document.querySelectorAll('.arp-rate')[0]);
  window.setArpMode('updown', document.querySelectorAll('.arp-mode')[2]);
  document.querySelector('.ibtn[data-w="sawtooth"]').click();
  window.setScaleName('minor'); window.setScaleRoot(9);
  // loops: 2-bar drum chain, 2-bar roll chain, 1-bar drum (divides the master)
  await D.pushSeqToLoop();
  await P.pushPseqToLoop();
  window.toggleChain();                 // off → single bar
  await D.pushSeqToLoop();
  window.toggleChain();                 // back on for the save
  window.setVol(1, 0.7);
  window.nudgeSlot(2, 1);
  EQ.setBand(S.slots[0].eq, 3, { gain: 4.5 }); EQ.setBand(S.slots[0].eq, 6, { freq: 9000 });
  const s2 = S.slots[2]; const off = 1234; s2._trimOrig = s2.buffer; s2.buffer = T.rotateBuffer(s2.buffer, off); s2.trimOffset = off;
  // master fx
  document.getElementById('revSlider').value = 0.3; document.getElementById('dlySlider').value = 0.15; window.setGlobalFX();
  document.getElementById('masterVolSlider').value = 1.1; window.setMasterVol(1.1);
  // song builder
  window.openSong(); window.songSetLabel(0, 'Hello'); window.songChBeats(1, 2); window.closeSong();
  document.getElementById('song-fmt').value = 'mp3'; document.getElementById('song-target').value = '-9';
  document.getElementById('mo-24').checked = true;
  document.getElementById('expFmt').value = 'mp3'; document.getElementById('expTarget').value = '-14';
  return S.slots.map(s => s.buffer ? s.buffer.duration.toFixed(3) : null);
}"""


def diff(a, b, path=''):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            out += diff(a.get(k), b.get(k), f'{path}.{k}')
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f'{path}[{i}]')
    elif a != b:
        out.append(f'{path}: {str(a)[:120]} != {str(b)[:120]}')
    return out


async def main():
    results, errors = {}, []
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = await browser.new_context(viewport={'width': 1366, 'height': 768}, accept_downloads=True)
        page = await ctx.new_page()
        dialogs = []

        async def on_dialog(d):
            dialogs.append((d.type, d.message[:90]))
            await d.accept()
        page.on('dialog', lambda d: asyncio.ensure_future(on_dialog(d)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'favicon' not in m.text else None)
        page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        missing = []
        page.on('response', lambda r: missing.append(r.url) if r.status == 404 else None)

        await page.goto(URL); await page.wait_for_timeout(700)
        durs = await page.evaluate(BUILD_JS)
        results['loop_durations'] = durs
        assert durs[0] == durs[1] == '4.800' and durs[2] == '2.400', durs      # 2-bar chain renders at 100 BPM
        await page.wait_for_timeout(400)                                      # let EQ parameter smoothing settle
        before = json.loads(await page.evaluate(SNAP_JS))
        await page.screenshot(path=str(OUT / 'state_1366.png'))

        # ── save ──
        async with page.expect_download() as dl:
            await page.click('#projSaveBtn')
        d = await dl.value
        proj_path = OUT / d.suggested_filename
        await d.save_as(proj_path)
        results['saved'] = f'{proj_path.name} {proj_path.stat().st_size / 1048576:.2f} MB'
        chk = subprocess.run([sys.executable, str(Path(__file__).parent / 'zip_check.py'), str(proj_path)], capture_output=True, text=True)
        results['python_zipfile'] = chk.stdout.strip().splitlines()[-1] if chk.returncode == 0 else 'FAIL ' + chk.stderr[-300:]
        assert chk.returncode == 0, chk.stderr

        # ── reload + open ──
        await page.reload(); await page.wait_for_timeout(700)
        fresh = json.loads(await page.evaluate(SNAP_JS))
        assert fresh['loopHashes'] != before['loopHashes']
        await page.set_input_files('#projFile', str(proj_path))
        await page.wait_for_function("document.getElementById('statusMsg').textContent.startsWith('Opened')", timeout=15000)
        after = json.loads(await page.evaluate(SNAP_JS))
        dd = diff(before, after)
        results['save_open_state_equal'] = not dd
        if dd:
            print('STATE DIFF:\n  ' + '\n  '.join(dd[:40]))
        results['status_after_open'] = await page.text_content('#statusMsg')

        # ── MIDI export (2-bar chain) → wipe → Import MIDI ──
        banks_before = await page.evaluate("() => { window.__looper.collectProject(); return JSON.stringify(window.__looper.S.banks.slice(0, 2)); }")
        async with page.expect_download() as dl:
            await page.click('#midiBtn')
        d = await dl.value
        mid_path = OUT / d.suggested_filename
        await d.save_as(mid_path)
        await page.evaluate("""async () => { const B = await import('/js/looper/banks.js'); window.toggleChain(); B.setBanks([], 0); window.setChainStr('A'); }""")
        n_dialogs = len(dialogs)
        await page.set_input_files('#midiFile', str(mid_path))
        await page.wait_for_function("document.getElementById('statusMsg').textContent.startsWith('Imported')", timeout=10000)
        results['midi_import_status'] = await page.text_content('#statusMsg')
        results['midi_dialogs'] = dialogs[n_dialogs:]
        banks_after = await page.evaluate("() => { window.__looper.collectProject(); return JSON.stringify(window.__looper.S.banks.slice(0, 2)); }")
        bb, ba = json.loads(banks_before), json.loads(banks_after)
        mism = []
        for i in range(2):
            for r in range(8):
                for s in range(16):
                    on0, on1 = bool(bb[i]['seq'][r][s]), bool(ba[i]['seq'][r][s])
                    if on0 != on1 or (on0 and (abs(bb[i]['seq'][r][s] - ba[i]['seq'][r][s]) > 0.013 or bb[i]['rat'][r][s] != ba[i]['rat'][r][s])):
                        mism.append(f'bank{i} drum {r}/{s}')
            if bb[i]['roll'] != ba[i]['roll']:
                mism.append(f'bank{i} roll')
        results['midi_roundtrip_equal'] = not mism
        if mism:
            print('MIDI MISMATCH', mism[:20])
        results['chain_after_import'] = await page.input_value('#chainInput')

        # ── MP3 export at -14 LUFS ──
        await page.select_option('#expFmt', 'mp3'); await page.select_option('#expTarget', '-14')
        async with page.expect_download() as dl:
            await page.click('#exportBtn')
        d = await dl.value
        mp3_path = OUT / d.suggested_filename
        await d.save_as(mp3_path)
        head = mp3_path.read_bytes()[:4]
        results['mp3_file'] = f'{mp3_path.name} {mp3_path.stat().st_size} bytes, header {head[:2].hex(" ").upper()}'
        assert head[0] == 0xFF and head[1] in (0xFB, 0xFA), head
        results['mp3_readout'] = await page.text_content('#expReadout')
        last = await page.evaluate('() => window.__looperLastExport')
        assert abs(last['lufs'] - (-14)) <= 0.5 and last['truePeakDb'] <= -0.95, last
        b64 = base64.b64encode(mp3_path.read_bytes()).decode()
        remeasure = await page.evaluate("""async (b64) => {
          const L = await import('/js/shared/loudness.js');
          const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          const ac = new OfflineAudioContext(2, 48000, 48000);
          const buf = await ac.decodeAudioData(bin.buffer);
          const m = L.measureLoudness(buf);
          return { lufs: m.lufs, tp: m.truePeakDb, dur: buf.duration };
        }""", b64)
        results['mp3_decoded_lufs'] = round(remeasure['lufs'], 2)
        assert abs(remeasure['lufs'] + 14) <= 0.5, remeasure

        # ── WAV export at -16 ──
        await page.select_option('#expFmt', 'wav'); await page.select_option('#expTarget', '-16')
        async with page.expect_download() as dl:
            await page.click('#exportBtn')
        d = await dl.value
        await d.save_as(OUT / d.suggested_filename)
        results['wav_readout'] = await page.text_content('#expReadout')
        last = await page.evaluate('() => window.__looperLastExport')
        assert abs(last['lufs'] + 16) <= 0.5, last

        # ── Song Builder render (MP3, -9 LUFS from the opened project) ──
        await page.evaluate('() => window.openSong()')
        await page.wait_for_timeout(200)
        async with page.expect_download(timeout=60000) as dl:
            await page.click('#song-render-btn')
        d = await dl.value
        song_path = OUT / d.suggested_filename
        await d.save_as(song_path)
        results['song_file'] = f'{song_path.name} header {song_path.read_bytes()[:2].hex(" ").upper()}'
        results['song_readout'] = await page.text_content('#song-readout')
        last = await page.evaluate('() => window.__looperLastExport')
        assert abs(last['lufs'] + 9) <= 0.5 and last['truePeakDb'] <= -0.95, last
        await page.screenshot(path=str(OUT / 'song_1366.png'))
        await page.evaluate('() => window.closeSong()')

        # ── chain playback order + queued switch ──
        order = await page.evaluate("""async () => {
          const S = window.__looper.S;
          window.chBPM(240 - S.bpm);                       // 1 s bars
          window.setChainStr('A B A C'); if (!S.chainOn) window.toggleChain();
          S.bankPlayLog = [];
          window.toggleSeq();
          await new Promise(r => setTimeout(r, 5300));
          window.toggleSeq();
          const log = S.bankPlayLog.slice(); S.bankPlayLog = null;
          if (S.chainOn) window.toggleChain();              // off
          window.clickBank(0);
          window.toggleSeq();
          await new Promise(r => setTimeout(r, 300));
          window.clickBank(1);
          const queued = S.bankQueued, curAtClick = S.bankCur;
          await new Promise(r => setTimeout(r, 1200));
          const curAfterBar = S.bankCur;
          window.toggleSeq();
          return { log, queued, curAtClick, curAfterBar };
        }""")
        results['chain_play_order'] = ' '.join(order['log'])
        assert order['log'][:5] == ['A', 'B', 'A', 'C', 'A'], order
        results['queued_switch'] = f"clicked B while playing: queued={order['queued']}, bank stayed {order['curAtClick']}, after bar line -> {order['curAfterBar']}"
        assert order['queued'] == 1 and order['curAtClick'] == 0 and order['curAfterBar'] == 1, order

        # ── Clear All asks first (unsaved work) ──
        n = len(dialogs)
        await page.click('text=✕ Clear All')
        await page.wait_for_timeout(200)
        results['clear_all_dialog'] = dialogs[n:]
        assert any(t == 'confirm' and 'Clear all' in m for t, m in dialogs[n:]), dialogs[n:]

        # ── layout screenshots after reopening the project ──
        await page.set_input_files('#projFile', str(proj_path))
        await page.wait_for_function("document.getElementById('statusMsg').textContent.startsWith('Opened')", timeout=15000)
        await page.screenshot(path=str(OUT / 'opened_1366.png'))
        await page.set_viewport_size({'width': 1920, 'height': 1040})
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(OUT / 'opened_1920.png'))
        await page.evaluate("() => { window.showHelp(); document.querySelector('.help-body').scrollTop = 0; }")
        await page.wait_for_timeout(200)
        await page.screenshot(path=str(OUT / 'help_1920.png'))
        overflow = await page.evaluate("() => ({ top: document.getElementById('topbar').scrollWidth > document.getElementById('topbar').clientWidth, status: document.getElementById('statusBar').scrollWidth > document.getElementById('statusBar').clientWidth })")
        results['overflow_1920'] = overflow

        results['console_errors'] = [e for e in errors if 'status of 404' not in e]
        results['404s'] = sorted(set(missing))
        await browser.close()

    print(json.dumps(results, indent=1, ensure_ascii=False))
    ok = results['save_open_state_equal'] and results['midi_roundtrip_equal'] and not results['console_errors']
    print('\nPAGE TEST', 'PASSED' if ok else 'FAILED')
    sys.exit(0 if ok else 1)

asyncio.run(main())
