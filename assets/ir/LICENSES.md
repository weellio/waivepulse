# Impulse response licences

Every impulse response bundled in this folder is redistributed under a permissive
licence. Nothing here requires an attribution notice inside the app UI, but the
sources are named below anyway, and this file travels with the files.

Prepared by `scripts/fetch_irs.py` (resample to 48 kHz, trim lead-in,
truncate at -60 dB with a 30 ms fade, peak -1 dBFS,
16-bit FLAC). Total bundled: **828 KiB** across 8 rooms.

## Source

**itsmusician/IR-Library** — <https://github.com/itsmusician/IR-Library> (rev `main`)
Licence: **MIT** — Copyright (c) 2022 Conner
Full text: <https://github.com/itsmusician/IR-Library/blob/main/License.md>

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction… The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software.

The MIT notice above is reproduced in full in `MIT-itsmusician-IR-Library.txt`
next to this file.

## Files

| File | Room | Length | Size | Licence | Source capture |
|---|---|---|---|---|---|
| `small-room.flac` | Small Room | 0.54 s | 40 KiB | MIT | `Rooms/Commercial/Hotels/Guest Rooms/Hotel Room 1 XY (Balloon).wav` |
| `live-room.flac` | Live Room | 0.52 s | 43 KiB | MIT | `Rooms/Residential/Ranch House/Ranch House Open Living Room.wav` |
| `studio-chamber.flac` | Studio Chamber | 0.86 s | 77 KiB | MIT | `Rooms/Public/Colleges & Universities/University of Central Florida/Old Audio Engineering Club Room.wav` |
| `concert-hall.flac` | Concert Hall | 3.76 s | 298 KiB | MIT | `Rooms/Commercial/Hotels/Ballrooms/Palm Ballroom.wav` |
| `cathedral.flac` | Cathedral | 2.54 s | 117 KiB | MIT | `Rooms/Historical/Landmarks/The Pantheon (Rome)/The Pantheon Optimal.wav` |
| `plate.flac` | Steel Plate | 3.02 s | 120 KiB | MIT | `Plates/Conner Plate I/Conner Plate I Sweeps/Conner Plate I 10s -36.wav` |
| `spring.flac` | Spring Tank | 2.60 s | 129 KiB | MIT | `Speakers/Amplifiers/Jazz Chorus 120/JC-120 Spring 5s -42.wav` |
| `cab.flac` | Amp Cab | 0.09 s | 3 KiB | MIT | `Speakers/Amplifiers/Jazz Chorus 120/JC-120 True Stereo Chorus Dry.wav` |

## Sets deliberately NOT used

| Set | Why not |
|---|---|
| OpenAIR (York) | CC-BY, usable in principle, but the host's TLS certificate is expired so the captures cannot be fetched over a verified connection. Dropped rather than downloaded insecurely. |
| EchoThief | Licence does not grant redistribution. |
| Samplicity Bricasti M7 | Licence restricts redistribution of the IR files. |
| Voxengo IR packs | Licence conflicts with bundling in an app. |
| Isophonics / Pori / SRIRACHA | Research-use or non-commercial terms that conflict with this project's licence. |

Trademarks named in the source capture paths (e.g. amplifier model names) belong to
their owners and are used for identification only; no affiliation or endorsement is
implied. See the source repository's `References.md`.
