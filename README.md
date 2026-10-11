# Reel Room

A browser-based editor for one kind of Instagram Reel: the film-frame life montage. Think "Beautiful ain't it…", "missing this…" and "POV: you go on a summer roadtrip with your friends". A stream of real moments from your trips and friends, each in a widescreen frame inside the black vertical Reel, cut on every beat of the song.

Drop in your clips and a song (or any video that has the song in it). Reel Room scans every clip for its best moments, maps the beat, and cuts the montage for you.

## The style

The editing rules come from measuring reference reels frame by frame against their music.

- **Film frame.** The picture is a horizontal band (16:9, 4:3 or square) sitting slightly above centre in a black 9:16 Reel. A full-screen option is there too.
- **A cut on every beat.** The reference reels cut every 0.34–0.53 s, within 0.05 s of the beat. Shots hold for two beats on the opening, on the drop, and at the end. On the same music, the planner reproduces 86% of the real cut points of the main reference reel.
- **Hard cuts.** The only extras are a punch-in (the same take continues, cut in tighter on the beat) and a single motion-blur and white-flash bridge into the drop.
- **Film grades.** *Cinema* has teal shadows, golden highlights, deep blacks and grain. *Summer film* is faded and warm, like a road-trip home video. *Postcard* is clean, rich holiday colour. *Dusk*, *Mono* and *Natural* are there too.
- **A small serif "POV: …" line** in the black space above the picture, for the whole reel (Road trip style).

Three styles package these rules:

| Style | Frame | Pace | Look | Text |
| --- | --- | --- | --- | --- |
| Cinema (default) | 16:9 | every beat, punch-ins, one blur flash | Cinema | none |
| Road trip | 4:3 | relaxed: 1 to 4 beats following the phrases | Summer film | POV caption |
| Holiday | 1:1 | every beat, punch-ins | Postcard | none |

## What else it does

- **Finds your best moments** on your device: sharpness, exposure, colour, movement, faces where the browser supports it, and loud moments in the clip's own sound.
- **Pulls music from any video or audio file:** tempo, every beat, bar lines, and the strongest part of the song for your reel's length. Drag to pick another part, or save the extracted audio.
- **AI Director (when opened as a Claude artifact).** Claude looks at a contact sheet of your best moments, favours atmospheric shots (wide views, golden hour, silhouettes, friends in the moment), orders them, and writes the POV line and an understated caption.
- **Keeps the subject in the frame:** the crop follows the subject, and you can drag on the preview to reframe a shot.
- **Editing:** a timeline with a beat ruler; drag to reorder, drag a shot's edge to change its length (it snaps to beats); split, duplicate, delete, undo/redo; per-shot source window, speed, transition, framing and zoom; "try another moment".
- **Text:** caption, editorial, headline and handwritten styles, placed above the picture, below it, or on it.
- **Sound:** music volume, original clip sound and a fade-out.
- **Export:** MP4 at 1080×1920 (or 720p), a cover image and a caption ready to copy.

Keyboard: Space play/pause, S split, D duplicate, Delete remove shot, ←/→ step a frame (Shift for a second), Ctrl/⌘ Z undo, Shift Ctrl/⌘ Z redo.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # beat tracking, moment scoring and auto-edit tests
npm run build      # static site in dist/
npm run build:artifact   # single-file page in artifact/reel-room.html
```

The app opens with a sample reel made from built-in, procedurally drawn clips and a synthesised track, so you can try every feature before importing anything. "Start with my videos" clears it.

## How it works

Everything runs in the browser. Your videos never leave your device; the only network calls are Google Fonts and, if you turn on the AI Director inside Claude, one request that sends a contact sheet of small thumbnails.

| Part | File |
| --- | --- |
| Beat tracking: spectral-flux onsets, tempo by autocorrelation, dynamic-programming beat tracker, downbeat phase, energy per beat, best-section finder | `src/engine/beats.ts` |
| Frame scoring, moment picking, subject tracking for reframing | `src/engine/metrics.ts`, `src/engine/analyze.ts` |
| Auto edit: beat grid to shot slots (holds on the intro, drop and end), moment selection and ordering, punch-ins, POV caption | `src/engine/autoedit.ts` |
| WebGL compositor: film-frame band, crop and reframe, colour grade, transitions | `src/engine/renderer.ts` |
| Playback and export: video pool synced to the audio clock, MediaRecorder export | `src/engine/engine.ts` |
| Claude AI Director and captions | `src/engine/ai.ts` |
| UI (React) | `src/ui/`, `src/App.tsx`, `src/actions.ts`, `src/store.ts` |

## Limits

- Export records the reel in real time, so a 30 s reel takes about 30 s. Keep the tab in front while it records.
- Video formats are whatever your browser can play. iPhone HEVC (.mov) footage plays in Safari and in Chrome on Mac and Windows with hardware support; if a clip shows "can't play this video", export it as MP4 (H.264) first.
- Chrome, Edge and Safari export MP4. Firefox exports WebM, which Instagram may refuse.
- Vertical phone footage in a 16:9 frame keeps only a horizontal slice of the picture. The crop leans toward the middle, where people usually are; filming some clips horizontally, or picking the 4:3 or square frame, keeps more of the shot.
- Clips larger than 250 MB are analysed without their sound (to keep memory in check); the picture analysis is unaffected.
