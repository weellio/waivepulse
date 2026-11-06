# Where each feature is documented

Four surfaces describe this app, and they drift apart. Twice now features shipped and
reached only one of them: six Suno-v6 features never made it to waivepulse.com, and the
Looper's in-app help grew to seventeen sections while the README still described eight.

This table is the checklist for shipping a feature. `scripts/doc_audit.py` reads it and
fails if a cell points at something that does not exist, so the map cannot quietly rot
either.

## The four surfaces

| Surface | File | Who reads it |
|---|---|---|
| README | `README.md` | Someone deciding whether to install it, and future me |
| Landing page | `landing/index.php` | Someone deciding whether to try it. Deploy with `scripts/deploy_site.py` |
| In-app help | the page's own help modal, or the panel's own copy | Someone using it right now |
| Screenshot | `scripts/*_shot.py` → `assets/` and `landing/img/` | Both of the above |

Rules worth keeping:

- **The app is the source of truth.** If the help modal and the README disagree, the README is wrong.
- **A panel with its own warnings is a help surface.** The Generate page has no help modal; Song Check and Train a style carry their own copy, and that counts.
- **Landing copy is a claim, not a description.** Everything there must be true of the shipped build.
- **Re-run the shot script** when a panel changes, rather than hand-editing an image.

## The map

`README` is the anchor in README.md. `Landing` is a string that must appear in the rendered
page. `Help` is where the in-app copy lives. `Shot` is the script that regenerates the image.

<!-- doc-map:start -->
| Feature | README | Landing | Help | Shot |
|---|---|---|---|---|
| Start from a song or a picture | #start-from-a-song-or-a-picture | Start from a song or a picture | panel: index.html vibe card | — |
| Render tiers | #render-tiers | Render tiers | panel: vibe.js describeTier | — |
| Song Check | #song-check | It tells you what is wrong | panel: songcheck.js | songcheck_shot.py |
| Train a style (LoKr) | #train-a-style-on-your-own-songs-lokr | Train the model on your own songs | panel: lokr.js | — |
| Cover art | #cover-art | cover art | panel: cover.js | — |
| Pronunciation | #pronunciation | Make it sing the right word | lyrics.html help-note | pronounce_shot.py |
| Lyric Helper | #lyric-helper-features | Offline rhyme finder | lyrics.html help-note | — |
| Rewrite Section (ACE-Step) | #rewrite-section-ace-step | Rewrite one section | studio help: addtrack.js | repaint_shot.py |
| Add a Part (ACE-Step base) | #add-a-part-ace-step-base-model | Add a part it never had | studio help: addtrack.js | addtrack_shot.py |
| Mashup builder | #mashup-builder | Mashup builder | studio help: mashup.js | — |
| Sample this | #sample-this | Sample this | studio help: mashup.js | — |
| Stem separation and mixer | #stems | Six-stem separation | studio help: studio.html | — |
| Song builder (Looper) | #song-builder | Looper | looper.html help | — |
| Air Band | #air-band-webcam | Air Band | looper.html help | — |
| Karaoke | #karaoke-in-depth | Karaoke | karaoke.html | — |
| Multitrack tape | #multitrack-tape-in-depth | Multitrack tape | panel: tape.js | tape_shot.py |
<!-- doc-map:end -->

## Adding a feature

1. Build it, with its own in-app copy — the warnings a user needs *before* they commit.
2. Add a README section, and a bullet in the page's workflow list that links to it.
3. Add it to `landing/index.php`: a feature bullet, and a gallery card if it is visual.
4. Write `scripts/<name>_shot.py` if there is something to see, and copy the image to
   `assets/` (README) and `landing/img/` (site).
5. Add the row here.
6. `python scripts/doc_audit.py --strict`, then `python scripts/deploy_site.py`.
