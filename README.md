# Reel Room

A browser-based editor that turns your camera footage into beat-synced Instagram Reels.

Drop in your clips and a song (or any video that has the song in it). Reel Room scans every clip for its best moments, maps the beat of the music and cuts the moments together on the beat, vertical and ready to post.

## What it does

**Finds your best moments.** Every clip is scanned frame by frame on your device for sharpness, exposure, colour, movement, faces (where the browser supports it) and loud moments in the clip's own sound. The peaks become "moments" you can see on each clip and drop into the timeline.

**Music from any video.** Import a video or an audio file as the soundtrack and the audio track is pulled out of it. Reel Room detects the tempo, every beat and the start of each bar, and suggests the strongest part of the song (the drop or chorus) for the length of your reel. You can drag to pick a different part, or save the extracted audio.

**Auto edit on the beat.** One click builds the reel:

- every cut lands on a beat, and longer shots land on a bar line
- shots get shorter where the music gets louder (at the fast pace)
- the best shot opens the reel as the hook
- five styles (Clean, Hype, Cinematic, Film, Moody) set the colour look, transitions and beat effects
- pace (Chill, Balanced, Fast), length (auto, 7, 15, 30 or 60 s) and order (as it happened, or busiest shots on the loudest music)

**AI Director (when opened as a Claude artifact).** Claude looks at a contact sheet of your best moments, chooses which ones to use and in what order, labels each shot, and writes an opening title, an Instagram caption and hashtags. Outside the Claude viewer, everything else still runs fully on your device.

**Auto-reframe.** Horizontal footage is cropped to 9:16 while following the subject. You can override it per shot by dragging on the preview.

**Editing tools**

- timeline with beat ruler: drag to reorder, drag a shot's edge to change its length (snaps to beats), split, duplicate, delete, undo/redo
- per shot: which part of the clip to use, length in beats, speed (0.5× to 2×), transition (cut, dissolve, flash, punch zoom, whip pan, glitch), framing and zoom, "try another moment"
- colour looks with live previews (Natural, Vivid, Golden hour, Teal/orange, Film, Mono, Moody, Dreamy), strength, and exposure / contrast / saturation / warmth / fade / vignette / grain
- beat zoom: a small zoom kick on every beat
- text overlays in five styles with pop, fade, typewriter and rise animations
- sound mix: music volume, original clip sound, fade-out
- frame sizes 9:16 (Reel), 4:5 (feed), 1:1 and 16:9, plus an overlay that shows where Instagram's buttons and caption cover the video
- export to MP4 at 1080×1920 (or 720p) with a cover image and a caption ready to copy

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
| Auto edit: beat grid to shot slots, moment selection and ordering, transitions per style | `src/engine/autoedit.ts` |
| WebGL compositor: crop and reframe, colour grade, transitions | `src/engine/renderer.ts` |
| Playback and export: video pool synced to the audio clock, MediaRecorder export | `src/engine/engine.ts` |
| Claude AI Director and captions | `src/engine/ai.ts` |
| UI (React) | `src/ui/`, `src/App.tsx`, `src/actions.ts`, `src/store.ts` |

## Limits

- Export records the reel in real time, so a 30 s reel takes about 30 s. Keep the tab in front while it records.
- Video formats are whatever your browser can play. iPhone HEVC (.mov) footage plays in Safari and in Chrome on Mac and Windows with hardware support; if a clip shows "can't play this video", export it as MP4 (H.264) first.
- Chrome, Edge and Safari export MP4. Firefox exports WebM, which Instagram may refuse.
- Clips larger than 250 MB are analysed without their sound (to keep memory in check); the picture analysis is unaffected.
