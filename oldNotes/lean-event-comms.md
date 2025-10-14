Goal

  Refactor the journey session flow so card stacks stay steady during manual overrides, the audio stream
  remains the source of truth, and the heavyweight explorer payload is only fetched when it’s genuinely
  needed.

  ———

  Phase 1 – Tighten Session Plumbing

  - Honor ?session= overrides server-side (already done); confirm every endpoint that touches
  getSessionForRequest logs its resolution path.
  - Update the client helpers (syncStreamEndpoint, syncEventsEndpoint) so the audio element and SSE socket
  always share the same session id; verify no old code still hard-codes /events.
  - Keep the “audio client check” fallback (if the new session never gains a listener, revert to the last
  confirmed stream). Add structured logs for both success and revert paths.

  Phase 2 – Split SSE Payloads

  - Introduce two event types:
      1. heartbeat (lean payload): currentTrack, currentDirection, recommendedNext, userOverride, timing.
      2. explorer_snapshot (heavy bundle): full directions array, diversity metrics, stack counts.
  - Change /events to emit heartbeat on every update; only send explorer_snapshot when the current track
  actually changes or when a client explicitly requests it.
  - Update the client SSE handler: most messages update the Now Playing card and progress bar; only
  explorer_snapshot triggers a call to createDimensionCards.

  Phase 3 – Manual Override Flow

  - On /next-track selection, have the server return a small JSON body plus enqueue a selection_ack SSE event:
  {status: 'locked', trackId, reason}.
  - If prep fails (file missing, decode error), send selection_failed with the failure reason and the fallback
  track id.
  - Client-side, keep the existing cards visible whenever we’ve got a pending override and the heartbeat
  still references the same current track. Only drop the override or repaint when we receive a failure or a
  new explorer_snapshot.

  Phase 4 – Diagnostics and Recovery

  - Add a requestExplorerSnapshot() endpoint (or reuse /refresh-sse) so the UI can fetch the heavy bundle on
  demand (manual refresh button, big mismatches, etc.).
  - Expand logging around selection, ack, failure, and heartbeat to include the session id, current track id,
  and cached override state. That makes on-call triage straightforward.

  Phase 5 – Clean-up & Tests

  - Remove any redundant “auto-refresh explorer” timers introduced earlier now that the payloads are split.
  - Add targeted integration tests:
      - Manual selection → heartbeat confirms override → no card rebuild.
      - Inject simulated prep failure → client handles selection_failed, shows fallback, cards refresh once.
      - Track change → explorer snapshot arrives → cards rebuild exactly once.
  - Document the new SSE contract (event types, payload fields) for future agents.

