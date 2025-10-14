 Where You Are Today

  - The mixer pushes raw MP3 chunks straight down an HTTP response (streaming-webapp/drift-audio-mixer.js:1052).
  - startAudio() simply slaps that URL on the <audio> tag and hopes the browser buffer survives (public/scripts/page.js:1858).
  - When the process hiccups you get an ended stream and the whole session tears down, which is why the client-side “keepalive”
  logic is so touchy.

  Why MediaSource Helps

  - You can own the buffer: append chunks when you want, pause drained feeds, and peel away old data so the browser never
  reaches EOF unless you say so.
  - You can soft-restart the stream by resetting the SourceBuffer instead of nuking the session.
  - You get hooks to feed larger buffer windows, capture short history for “save” actions, and tolerate server restarts.

  Proposed Refactor (minimal server churn)

  1. Keep streaming MP3, wrap it in MSE
      - Chrome/Edge/Firefox accept audio/mpeg SourceBuffers; no need to rebuild your encoder pipeline.
      - Feature-detect once: MediaSource && MediaSource.isTypeSupported('audio/mpeg'). Safari will fail the check, so you fall
  back to today’s audio.src path.
  2. Introduce a client StreamController
      - New module (e.g. public/scripts/stream-controller.js) that:
          - Creates MediaSource, attaches to audio.src, sets up a single SourceBuffer('audio/mpeg').
          - Starts fetch(streamUrl, { signal }), pulls response.body.getReader(), and feeds chunks into an internal queue.
          - Appends to SourceBuffer when !updating; otherwise parks data in a FIFO.
          - Exposes start(fingerprintUrl), stop(reason), and softRestart() so existing session logic can drive it.
  3. Tighten start/recovery logic
      - Replace the direct elements.audio.src = streamUrl block at public/scripts/page.js:1858 with calls into the controller.
      - On SSE “restart”/heartbeat failures, call controller.softRestart() to recreate the MediaSource and resume pulling.
      - When fetch throws (network drop), back off per your existing retry envelope and restart the controller rather than
  killing the whole UI session.
  4. Buffer management knobs
      - Let the controller cap appended duration (e.g., 120 s). Use sourceBuffer.remove(0, currentTime - keepSeconds) to trim
  once playback is safely past.
      - Surface events up to the main state machine so you can show “buffering” vs “playing” accurately instead of guessing
  from <audio>.readyState.
  5. Server adjustments
      - Nothing fundamental needs to change—addClient() already sets Content-Type: audio/mpeg.
      - Optional: add a lightweight /stream/bootstrap that returns the resolved URL/fingerprint so the controller can preflight
  without opening the data pipe twice.
      - Consider tagging chunks with timestamps or heartbeat markers (even simple JSON comments) if you want the controller to
  detect “no audio for X seconds” without relying solely on playback time.
  6. Fallback & compatibility
      - Keep the old direct-stream branch behind a flag for browsers that can’t use MSE.
      - If long-term you move to WebM/Opus, only the MIME string and server encoder change—the controller API stays the same.

  Session-Management Wins

  - You can now restart the stream in place when /stream restarts, which means fewer dropped sessions and less thrash in
  state.isStarted.
  - Larger controlled buffers let you survive short backend stalls without racing to re-handshake.
  - Because the controller owns fetch + buffer state, you can coalesce “awaiting SSE + audio stalled” into a single reconnection
  path instead of the current double bookkeeping.

  Natural next steps:

  1. Sketch the StreamController skeleton and wire it behind a feature flag in public/scripts/page.js.
  2. Smoke-test in Chrome (MSE path) and Safari (fallback) to confirm both branches behave.
  3. Once stable, integrate the new restart hooks with the existing /refresh and SSE workflows so manual restarts reuse the same
  controller API.
