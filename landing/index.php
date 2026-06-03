<?php
/**
 * WAIvePulse — landing page (waivepulse.com)
 * Plain PHP/HTML. Data lives in arrays below so the markup stays a simple loop.
 */
$YEAR    = date('Y');
$GH      = 'https://github.com/weellio/waivepulse';
$DEMO    = 'https://www.youtube.com/watch?v=gKttuxGeLkw';

$badges = ['Free & open source', 'No cloud', 'No subscription', 'No API keys', 'No usage caps', 'Runs on your GPU'];

// Each feature -> a full-bleed section. `accent` keys into the CSS color vars.
$features = [
  [
    'tag'   => 'Generate',
    'accent'=> 'cyan',
    'img'   => 'img/generate.jpg',
    'kicker'=> 'HeartMuLa 3B',
    'title' => 'Type lyrics. Get a finished song.',
    'body'  => 'Paste your words, pick a few style tags, and a 3-billion-parameter model writes, sings, and produces a complete track as an MP3 — vocals and all. Jobs queue up; BPM and key are detected automatically.',
    'points'=> ['Full vocal songs from text', 'Multi-job queue with live progress', 'BPM + key auto-detection', 'Neural watermark + provenance baked in'],
  ],
  [
    'tag'   => 'Lyrics',
    'accent'=> 'green',
    'img'   => 'img/lyrics.jpg',
    'kicker'=> 'Local Llama via Ollama',
    'title' => 'Writer’s block, solved — privately.',
    'body'  => 'Stuck on a line? A local Llama model streams lyrics word-by-word, pre-formatted with the verse and chorus markers the generator expects. Send them straight to the studio with one click.',
    'points'=> ['Streaming, token-by-token output', 'Theme, structure, tone, rhyme controls', 'Frees VRAM the instant it finishes', 'Never leaves your machine'],
  ],
  [
    'tag'   => 'Studio',
    'accent'=> 'purple',
    'img'   => 'img/studio.jpg',
    'kicker'=> 'Demucs stem mixer',
    'title' => 'A full DAW in your browser.',
    'body'  => 'Every song splits into six stems on your GPU — vocals, drums, bass, guitar, piano, other. Mix them with per-track EQ, a master chain, a live visual EQ, mute automation, a rack of creative effects, and a lossless export.',
    'points'=> ['Six-stem separation', 'Per-track 7-band parametric EQ', 'Clipper · limiter · exciter · noise gate', 'Dattorro reverb · bitcrusher · wavefolder', 'Export the exact mix you hear'],
  ],
  [
    'tag'   => 'Looper',
    'accent'=> 'magenta',
    'img'   => 'img/looper.jpg',
    'kicker'=> 'Ed Sheeran in a tab',
    'title' => 'Build a track, layer by layer.',
    'body'  => 'A full loop station: synthesized drums with a 16-step sequencer, a two-octave synth with filter, arpeggiator and ADSR, a polyphonic piano roll for chords, a plucked-guitar voice, a sampler, and a mic with autotune — stacked into six loops. Fill cells to make held notes and read them back on a live sheet-music staff. Overdubs are auto-quantized, so every layer lands on the beat.',
    'points'=> ['Six layers with quantized overdub', 'Piano roll with held notes → live sheet-music notation', 'Drum sequencer + polyphonic piano roll → push to a loop', 'Two-octave synth: filter · arp · guitar · sampler', 'Per-loop 7-band parametric EQ + mic autotune'],
  ],
  [
    'tag'   => 'Karaoke',
    'accent'=> 'amber',
    'img'   => 'img/karaoke.jpg',
    'kicker'=> 'Performance mode',
    'title' => 'Lyric videos, ready to record.',
    'body'  => 'Whisper transcribes your vocals and aligns them to your original words. A fullscreen visualizer rolls the lyrics in a sliding window over your tuned mix — screen-record it and you’ve got a video for YouTube.',
    'points'=> ['Five-word sliding lyric window', '20+ reactive visual styles', 'Carries your full Studio mix', 'Toggle vocals for sing-along'],
  ],
];

$compare = [
  ['', 'WAIvePulse', 'Cloud generators', 'Pro DAWs'],
  ['Runs offline',            true,  false, true],
  ['Open source',            true,  false, false],
  ['Songs from lyrics',      true,  true,  false],
  ['Browser stem mixer',     true,  false, false],
  ['Built-in loop station',  true,  false, 'plugin'],
  ['Lyric-video output',     true,  false, false],
  ['Subscription',           'None','Monthly','Monthly'],
  ['Usage caps',             'None','Credits','None'],
];

function cell($v) {
  if ($v === true)  return '<span class="yes">✓</span>';
  if ($v === false) return '<span class="no">—</span>';
  if ($v === 'plugin') return '<span class="meh">add-on</span>';
  return '<span class="txt">'.htmlspecialchars($v).'</span>';
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WAIvePulse — Your studio. Your GPU. Your music.</title>
<meta name="description" content="A free, open-source local AI music studio. Write a song, generate it with vocals, mix the stems, loop it, and perform it — entirely offline on your own GPU. No cloud, no subscription, no limits.">
<meta property="og:title" content="WAIvePulse — local AI music studio">
<meta property="og:description" content="Write it. Generate it. Mix it. Loop it. Perform it. Entirely on your machine.">
<meta property="og:image" content="img/generate.jpg">
<link rel="icon" type="image/png" href="img/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="style.css">
</head>
<body>

<!-- Animated waveform background -->
<canvas id="bg"></canvas>
<div class="grain"></div>
<div class="orb orb-1"></div>
<div class="orb orb-2"></div>
<div class="orb orb-3"></div>

<!-- Nav -->
<header id="nav">
  <a class="brand" href="#top">
    <img src="img/logo.png" alt="">
    <span>WAIve<b>Pulse</b></span>
  </a>
  <nav class="links">
    <a href="#generate">Generate</a>
    <a href="#lyrics">Lyrics</a>
    <a href="#studio">Studio</a>
    <a href="#looper">Looper</a>
    <a href="#karaoke">Karaoke</a>
  </nav>
  <a class="gh-btn" href="<?= $GH ?>" target="_blank" rel="noopener">
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
    GitHub
  </a>
</header>

<!-- Hero -->
<section id="top" class="hero">
  <div class="hero-inner">
    <div class="eyebrow reveal">Free, local AI music studio · runs on your GPU</div>
    <h1 class="reveal">
      Your studio.<br>
      Your <span class="grad">GPU</span>.<br>
      Your music.
    </h1>
    <p class="lede reveal">
      Write it. Generate it. Mix it. Loop it. Perform it.
      One app, five tools, <b>free and offline</b> — every note stays on your machine.
    </p>
    <div class="cta reveal">
      <a class="btn primary" href="<?= $GH ?>" target="_blank" rel="noopener">Get WAIvePulse →</a>
      <a class="btn ghost" href="<?= $DEMO ?>" target="_blank" rel="noopener">▶ Watch a song made in it</a>
    </div>
    <div class="badges reveal">
      <?php foreach ($badges as $b): ?>
        <span class="badge"><?= htmlspecialchars($b) ?></span>
      <?php endforeach; ?>
    </div>
  </div>
  <div class="scroll-hint" aria-hidden="true"><span></span></div>
</section>

<!-- Flow strip -->
<section class="flow">
  <?php
    $steps = ['Write', 'Generate', 'Separate', 'Mix', 'Loop', 'Perform'];
    foreach ($steps as $i => $s):
  ?>
    <div class="flow-step reveal" style="--d: <?= $i * 60 ?>ms">
      <span class="num"><?= sprintf('%02d', $i + 1) ?></span>
      <span class="lbl"><?= $s ?></span>
    </div>
    <?php if ($i < count($steps) - 1): ?><span class="flow-arrow" aria-hidden="true">→</span><?php endif; ?>
  <?php endforeach; ?>
</section>

<!-- Features -->
<?php foreach ($features as $i => $f): ?>
<section class="feature <?= $i % 2 ? 'flip' : '' ?>" id="<?= strtolower($f['tag']) ?>" data-accent="<?= $f['accent'] ?>">
  <div class="f-text reveal">
    <div class="f-tag"><?= htmlspecialchars($f['tag']) ?> <span><?= htmlspecialchars($f['kicker']) ?></span></div>
    <h2><?= htmlspecialchars($f['title']) ?></h2>
    <p><?= htmlspecialchars($f['body']) ?></p>
    <ul>
      <?php foreach ($f['points'] as $p): ?>
        <li><?= htmlspecialchars($p) ?></li>
      <?php endforeach; ?>
    </ul>
  </div>
  <div class="f-shot reveal">
    <div class="shot-frame">
      <img src="<?= $f['img'] ?>" alt="<?= htmlspecialchars($f['tag']) ?> screenshot" loading="lazy">
    </div>
  </div>
</section>
<?php endforeach; ?>

<!-- Comparison -->
<section class="why reveal">
  <h2 class="section-title">Why <span class="grad">WAIvePulse</span></h2>
  <p class="section-sub">A one-time install in exchange for permanent freedom from the cloud.</p>
  <div class="table-wrap">
    <table>
      <?php foreach ($compare as $r => $row): ?>
        <tr class="<?= $r === 0 ? 'head' : '' ?>">
          <?php foreach ($row as $c => $val): ?>
            <?php if ($r === 0): ?>
              <th class="<?= $c === 1 ? 'us' : '' ?>"><?= htmlspecialchars($val) ?></th>
            <?php elseif ($c === 0): ?>
              <td class="rowlbl"><?= htmlspecialchars($val) ?></td>
            <?php else: ?>
              <td class="<?= $c === 1 ? 'us' : '' ?>"><?= cell($val) ?></td>
            <?php endif; ?>
          <?php endforeach; ?>
        </tr>
      <?php endforeach; ?>
    </table>
  </div>
</section>

<!-- Specs -->
<section class="specs reveal">
  <div class="spec"><span class="big" data-count="6">6</span><span>stems per song</span></div>
  <div class="spec"><span class="big" data-count="5">5</span><span>tools, one app</span></div>
  <div class="spec"><span class="big" data-count="0">0</span><span>API keys needed</span></div>
  <div class="spec"><span class="big">∞</span><span>songs, no limits</span></div>
</section>

<!-- Final CTA -->
<section class="final">
  <div class="final-card reveal">
    <h2>Make music the cloud can’t touch.</h2>
    <p>Free and open source. Windows or Linux, an NVIDIA GPU with ~12&nbsp;GB, and you’re running your own studio in minutes.</p>
    <div class="cta">
      <a class="btn primary" href="<?= $GH ?>" target="_blank" rel="noopener">Get it on GitHub →</a>
      <a class="btn ghost" href="<?= $DEMO ?>" target="_blank" rel="noopener">▶ See the demo</a>
    </div>
  </div>
</section>

<footer>
  <div class="foot-brand">
    <img src="img/logo.png" alt="">
    <span>WAIve<b>Pulse</b></span>
  </div>
  <div class="foot-meta">
    <span>© <?= $YEAR ?> WAIvePulse · MIT + Commons Clause</span>
    <span>Built for people who’d rather own their tools.</span>
  </div>
</footer>

<script src="app.js"></script>
</body>
</html>
