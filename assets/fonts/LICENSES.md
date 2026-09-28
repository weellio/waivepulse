# Vendored font licences

These TrueType files are the typography used by `backend/cover.py` to set album
cover art (display faces, serifs, monospace and one blackletter). They were
vendored from the Google Fonts repository (<https://github.com/google/fonts>).

**Every font here is under the SIL Open Font License 1.1 (OFL).** No font in
this directory is under any other licence, and none required Apache 2.0.
The OFL permits redistribution, bundled or standalone, provided the copyright
notice and licence text travel with the files — which is why each family's
upstream `OFL.txt` is kept here as `OFL-<family>.txt`. Those files are the
authoritative, full licence texts; the table below only summarises them.

Licences were read from the `OFL-*.txt` files, and family names, copyright
strings and licence strings were cross-checked against each font's `name`
table with fontTools.

## Fonts

| File | Family | Licence | Copyright holder | Upstream |
| --- | --- | --- | --- | --- |
| `Anton-Regular.ttf` | Anton | OFL 1.1 | Copyright 2020 The Anton Project Authors | [ofl/anton](https://github.com/google/fonts/tree/main/ofl/anton) |
| `Archivo-VF.ttf` [1] | Archivo (variable: `wght` 100–900, `wdth` 62–125) | OFL 1.1 | Copyright 2020 The Archivo Project Authors | [ofl/archivo](https://github.com/google/fonts/tree/main/ofl/archivo) |
| `ArchivoBlack-Regular.ttf` | Archivo Black | OFL 1.1 | Copyright 2017 The Archivo Black Project Authors | [ofl/archivoblack](https://github.com/google/fonts/tree/main/ofl/archivoblack) |
| `BebasNeue-Regular.ttf` | Bebas Neue | OFL 1.1 | Copyright © 2010 by Dharma Type [3] | [ofl/bebasneue](https://github.com/google/fonts/tree/main/ofl/bebasneue) |
| `BigShouldersDisplay-VF.ttf` [1] | Big Shoulders Display (variable: `wght` 100–900) | OFL 1.1 | Copyright 2019 The Big Shoulders Project Authors | [ofl/bigshouldersdisplay](https://github.com/google/fonts/tree/main/ofl/bigshouldersdisplay) |
| `CourierPrime-Regular.ttf` | Courier Prime | OFL 1.1 | Copyright 2015 The Courier Prime Project Authors | [ofl/courierprime](https://github.com/google/fonts/tree/main/ofl/courierprime) |
| `DMSerifDisplay-Regular.ttf` | DM Serif Display | OFL 1.1 | Copyright 2014-2018 Adobe, with Reserved Font Name 'Source'; Copyright 2019 Google LLC | [ofl/dmserifdisplay](https://github.com/google/fonts/tree/main/ofl/dmserifdisplay) |
| `Fraunces-VF.ttf` [1] | Fraunces (variable: `opsz` 9–144, `wght` 100–900, `SOFT` 0–100, `WONK` 0–1) | OFL 1.1 | Copyright 2018 The Fraunces Project Authors [3] | [ofl/fraunces](https://github.com/google/fonts/tree/main/ofl/fraunces) |
| `InstrumentSerif-Regular.ttf` | Instrument Serif | OFL 1.1 | Copyright 2022 The Instrument Serif Project Authors | [ofl/instrumentserif](https://github.com/google/fonts/tree/main/ofl/instrumentserif) |
| `InstrumentSerif-Italic.ttf` | Instrument Serif Italic | OFL 1.1 | Copyright 2022 The Instrument Serif Project Authors | [ofl/instrumentserif](https://github.com/google/fonts/tree/main/ofl/instrumentserif) |
| `JetBrainsMono-VF.ttf` [1] | JetBrains Mono (variable: `wght` 100–800) | OFL 1.1 | Copyright 2020 The JetBrains Mono Project Authors | [ofl/jetbrainsmono](https://github.com/google/fonts/tree/main/ofl/jetbrainsmono) |
| `Oswald-VF.ttf` [1] | Oswald (variable: `wght` 200–700) | OFL 1.1 | Copyright 2016 The Oswald Project Authors | [ofl/oswald](https://github.com/google/fonts/tree/main/ofl/oswald) |
| `PlayfairDisplay-VF.ttf` [1] | Playfair Display (variable: `wght` 400–900) | OFL 1.1 | Copyright 2017 The Playfair Display Project Authors, with Reserved Font Name "Playfair Display" | [ofl/playfairdisplay](https://github.com/google/fonts/tree/main/ofl/playfairdisplay) |
| `SpaceGrotesk-VF.ttf` [1] | Space Grotesk (variable: `wght` 300–700) | OFL 1.1 | Copyright 2020 The Space Grotesk Project Authors | [ofl/spacegrotesk](https://github.com/google/fonts/tree/main/ofl/spacegrotesk) |
| `Syne-VF.ttf` [1] | Syne (variable: `wght` 400–800) | OFL 1.1 | Copyright 2017 The Syne Project Authors | [ofl/syne](https://github.com/google/fonts/tree/main/ofl/syne) |
| `UnifrakturMaguntia-Book.ttf` | UnifrakturMaguntia | OFL 1.1 | Copyright (c) 2010, j. 'mach' wust, with Reserved Font Name UnifrakturMaguntia; Copyright (c) 2009, Peter Wiegel | [ofl/unifrakturmaguntia](https://github.com/google/fonts/tree/main/ofl/unifrakturmaguntia) |

16 files, 15 families, all OFL 1.1 (15 licence texts — Instrument Serif Regular
and Italic share `OFL-instrumentserif.txt`).

## Notes

1. **`-VF.ttf` files are renamed upstream variable fonts.** Upstream names the
   variable font with its axis tags in square brackets, which is awkward in
   paths and build scripts, so each was renamed to `<Family>-VF.ttf`. The bytes
   are unmodified. For example `SpaceGrotesk[wght].ttf` became
   `SpaceGrotesk-VF.ttf`, and `Fraunces[SOFT,WONK,opsz,wght].ttf` became
   `Fraunces-VF.ttf`. The axis ranges in the table above are read from each
   file's `fvar` table, so they identify the upstream file the name came from.
2. Renaming a file is not modifying the font: the internal family names are
   untouched, so no OFL Reserved Font Name is affected.
3. Where the upstream `OFL.txt` and the font's internal `name` table word the
   copyright differently, the table above quotes the `OFL.txt`, which is the
   licence of record. The two differences: Bebas Neue's `name` table reads
   "Copyright 2019 The Bebas Neue Project Authors
   (https://github.com/dharmatype/Bebas-Neue)", and Fraunces' reads
   "Copyright 2020 The Fraunces Project Authors". Both are the same holders,
   restated.
4. Copyright lines are abbreviated here by dropping the trailing project URL.
   The verbatim line is the first line of the matching `OFL-<family>.txt`.
5. `backend/cover.py` also falls back to a broad-coverage system font
   (Segoe UI, Arial or DejaVu Sans, whichever the host has) when a display face
   cannot draw a glyph. Those are the operating system's own fonts, are never
   vendored here, and are not redistributed with this project.

## NOT CLEARED

None. Every `.ttf` in this directory is SIL Open Font License 1.1.
