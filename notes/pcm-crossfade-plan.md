PCM / Crossfade Overhaul Notes
================================

## Immediate Goals
- Operate mixer entirely on PCM (44.1 kHz, 16-bit stereo).
- Deliver high-quality silence-aware equal-power crossfades.
- Stream mixed audio as FLAC (`audio/flac`).
- Add basic seek/skip tooling for testing only.

## Buffering Strategy
- Decode intro/outro windows (~60 s each) instead of whole tracks.
- Stream the middle of each track on demand; no long-lived PCM for it.
- Warm sessions hold one decoded intro window; decode outros asynchronously as playback nears.
- Candidate tracks decode intro windows only; promote/outro decode when committed.

## Crossfade Heuristics
- Trim leading/trailing silence, capture energy envelopes.
- Base fade length on outro decay and intro onset strength.
- Align fades to trimmed windows (outgoing tail vs incoming first meaningful audio).
- Use equal-power cosine curves; clamp gracefully for short windows.

## FLAC Output
- Pipe PCM into libFLAC/ffmpeg with low-latency block size (<100 ms).
- Serve via HTTP chunked `audio/flac` endpoint (no fallback yet).

## Drift Player Integration
- Mixer emits mixability metrics (silence duration, energy slope) when prepping transitions.
- Drift player biases candidate selection using these hints.
- Later: rank candidates by mix quality without decoding full tracks.

## Seek / Testing
- Provide simple developer seek (e.g., jump ahead/back 3×10 s) without polish.

## Risks / Watchpoints
- Silence detection accuracy to avoid clipping transients.
- Memory footprint with multiple warm sessions; monitor intro/outro window sizes.
- FLAC encoding latency; tune block size if necessary.
- Ensure mixer doesn’t stall waiting for intro/outro decode.
