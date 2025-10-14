# Named Sessions & Stack Implementation Plan

**Date:** 2025-10-02
**Status:** Ready for Implementation
**Based on:** SESSION_DESIGN_AUDIT.md, NAMED_SESSIONS_DESIGN.md, EXPLORER_STACK_DESIGN.md

---

## Critical Clarifications

### 1. URL Navigation is WRITE, not READ
**`/:name/:index/:seconds` is a WRITE operation**

```javascript
// User visits: /myname/4/20
// Server response:
1. Load session "myname"
2. SET stackIndex = 4
3. SET positionSeconds = 20
4. Save session state (persist position)
5. Serve HTML with session state injected
6. Client connects, resumes at track 4, 20 seconds in
```

**This is navigation + state modification in one action.**

### 2. Source is Advisory Metadata
**`source` field describes origin - can be direction or other labels**

```javascript
// Stack format: { md5, source }
// source examples:
//   - "bpm_positive"     (radial direction)
//   - "playlist"         (from imported playlist)
//   - "journey"          (external algorithm)
//   - "manual"           (hand-picked)

// Client force-insert logic:
if (sourceIsDirection && trackInDirection) {
  // Use suggested direction
  explorerData.directions[source].sampleTracks.unshift(track);
} else {
  // Find ANY direction containing track
  const anyDirection = findDirectionContainingTrack(track);
  explorerData.directions[anyDirection].sampleTracks.unshift(track);
}

// If track not in ANY direction → FATAL ERROR, stop playback
```

**Key: Source is storytelling metadata. Track existence is validated on load.**

### 3. Client Drives, Server Stores
**Server NEVER auto-advances stack - client does everything**

```javascript
// WRONG (server-driven):
// When track ends, server increments stackIndex, picks next track

// CORRECT (client-driven):
eventSource.onmessage = (event) => {
  if (event.type === 'track_started') {
    // Server just tells us new track started (drift or forced)

    // Check local session state
    if (session.stackIndex < session.stack.length - 1) {
      const nextTrack = session.stack[session.stackIndex + 1];

      // Force-insert logic (client does this)
      forceTrackSelection(nextTrack.md5, nextTrack.direction);

      // Update local position
      session.stackIndex++;
      session.positionSeconds = 0;

      // Persist to server (optional, for resume)
      saveSessionPosition(session.stackIndex, 0);
    } else {
      // End of stack - flip to ephemeral (client decides)
      session.ephemeral = true;
    }
  }
}
```

**Server = passive storage, Client = active driver**

---

## Updated Missing Pieces

### ~~2. Seek Within Track~~ ✅ CLARIFIED
**No separate seek API needed** - URL navigation handles it:
- `/:name/4/20` → Jump to track 4, 20 seconds in
- Server sets state, client receives via SSE/page load

### ~~6. Direction Validation~~ ✅ CLARIFIED
**Not needed** - client forces track regardless of direction validity

### ~~7. Heartbeat Conflict~~ ✅ CLARIFIED
**No conflict** - client has full control:
```javascript
// Client priority (in order):
1. Check session.stack[stackIndex + 1] (named session has next track)
   → Force that track
2. Check explorerStack[0] (user queued track via explorer)
   → Force that track
3. Check userSelectedMd5 (user clicked direction)
   → Send that track
4. Else: Do nothing, let server drift naturally
```

---

## Revised Architecture

### Server Responsibilities (Minimal)
1. **Store session state** (`stack`, `stackIndex`, `positionSeconds`)
2. **Serve session state** on page load (injected into HTML)
3. **Provide explorer data** (`/explore-from-track`)
4. **Log history** (record transitions for analytics)
5. **Handle imports/exports** (CRUD on session state)

### Client Responsibilities (Maximal)
1. **Drive playback** (force next track from stack)
2. **Navigate stack** (update stackIndex, save to server)
3. **Build explorer UI** (rich layers from server data)
4. **Handle ephemeral mode** (detect end of stack, stop persisting)
5. **Persist changes** (POST stackIndex/positionSeconds back to server)

---

## Implementation Phases

### Phase 0: Foundation (Week 1)
**Goal:** Named sessions work with manual URL navigation

#### Server Tasks
- [ ] Add to `DriftAudioMixer` constructor:
  ```javascript
  this.stack = [];              // Array of { md5, source }
                                 // source = direction | 'playlist' | 'journey' | 'manual' | etc
  this.stackIndex = 0;           // Current playback position
  this.positionSeconds = 0;      // Position in current track
  this.ephemeral = false;        // Persistence flag
  this.isPersistent = false;     // true for named, false for MD5
  ```

- [ ] Implement `GET /tracks/metadata` batch endpoint:
  ```javascript
  app.get('/tracks/metadata', (req, res) => {
    const { md5s } = req.query; // Comma-separated: "abc123,def456,ghi789"

    if (!md5s) {
      return res.status(400).json({ error: 'md5s parameter required' });
    }

    const md5Array = md5s.split(',');
    const metadata = [];
    const missing = [];

    for (const md5 of md5Array) {
      const track = radialSearch.kdTree.getTrack(md5);

      if (track) {
        metadata.push({
          md5: track.identifier,
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          imageUrl: `/images/${track.identifier}.jpg`
        });
      } else {
        missing.push(md5);
      }
    }

    if (missing.length > 0) {
      console.warn(`⚠️ Missing tracks in metadata request: ${missing.join(', ')}`);
    }

    res.json({
      metadata,
      missing,
      count: metadata.length,
      requestedCount: md5Array.length
    });
  });
  ```

- [ ] Implement `/:name` route:
  ```javascript
  app.get('/:name', async (req, res) => {
    const name = req.params.name;

    // Validate: must be < 32 chars and not valid MD5
    if (name.length === 32 && /^[a-f0-9]{32}$/.test(name)) {
      return next(); // Pass to MD5 handler
    }

    // Get or create named session
    let session = audioSessions.get(name);
    if (!session) {
      session = await createPreloadedSession(name);
      session.mixer.isPersistent = true;
      audioSessions.set(name, session);
    }

    // Serve HTML with session state
    const html = injectSessionState(readHTML(), session);
    res.send(html);
  });
  ```

- [ ] Implement `/:name/:index/:seconds` route:
  ```javascript
  app.get('/:name/:index/:seconds?', async (req, res) => {
    const { name, index, seconds } = req.params;

    let session = audioSessions.get(name);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // WRITE operation: update session state
    session.mixer.stackIndex = parseInt(index);
    session.mixer.positionSeconds = parseInt(seconds || 0);
    session.lastAccess = new Date();

    console.log(`🎯 Navigated ${name} to track ${index}, ${seconds || 0}s`);

    // Serve HTML with updated state
    const html = injectSessionState(readHTML(), session);
    res.send(html);
  });
  ```

- [ ] Implement `POST /session/:name/position`:
  ```javascript
  app.post('/session/:name/position', (req, res) => {
    const { stackIndex, positionSeconds } = req.body;
    const session = audioSessions.get(req.params.name);

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.mixer.stackIndex = stackIndex;
    session.mixer.positionSeconds = positionSeconds;
    session.lastAccess = new Date();

    res.json({ ok: true, stackIndex, positionSeconds });
  });
  ```

- [ ] Update session cleanup (server.js):
  ```javascript
  // In cleanup interval:
  for (const [sessionId, session] of audioSessions) {
    const isPersistent = session.mixer.isPersistent || false;

    if (isPersistent) {
      // Named sessions: NEVER auto-cleanup
      continue;
    }

    // MD5/anonymous: cleanup after 60min
    if (now - session.lastAccess > 60 * 60 * 1000) {
      session.mixer.destroy();
      audioSessions.delete(sessionId);
    }
  }
  ```

- [ ] Helper: Inject session state into HTML:
  ```javascript
  function injectSessionState(html, session) {
    const state = {
      sessionId: session.sessionId,
      stack: session.mixer.stack || [],
      stackIndex: session.mixer.stackIndex || 0,
      positionSeconds: session.mixer.positionSeconds || 0,
      ephemeral: session.mixer.ephemeral || false,
      isPersistent: session.mixer.isPersistent || false
    };

    const script = `
    <script>
      window.sessionState = ${JSON.stringify(state)};
      console.log('📦 Session state loaded:', window.sessionState);
    </script>
    `;

    return html.replace('</head>', script + '\n</head>');
  }
  ```

#### Client Tasks
- [ ] Read session state on page load:
  ```javascript
  // In page.js initialization
  const sessionState = window.sessionState || {
    sessionId: null,
    stack: [],
    stackIndex: 0,
    positionSeconds: 0,
    ephemeral: false
  };

  console.log('📦 Loaded session:', sessionState);
  ```

- [ ] Validate and load stack metadata:
  ```javascript
  async function loadStackMetadata() {
    if (!sessionState.stack || sessionState.stack.length === 0) return;

    const md5s = sessionState.stack.map(item => item.md5).join(',');

    try {
      const response = await fetch(`/tracks/metadata?md5s=${md5s}`);
      const { metadata, missing } = await response.json();

      if (missing.length > 0) {
        console.error(`❌ Playlist corrupted - missing tracks:`, missing);
        showError(`Playlist contains ${missing.length} invalid track(s). Playback stopped.`);
        sessionState.ephemeral = true; // Stop persisting
        return false;
      }

      // Store metadata for photo row rendering
      sessionState.trackMetadata = metadata.reduce((acc, track) => {
        acc[track.md5] = track;
        return acc;
      }, {});

      console.log(`✅ Validated ${metadata.length} tracks in stack`);

      // Render photo row UI
      renderPhotoRow(metadata);

      return true;
    } catch (err) {
      console.error('Failed to load track metadata:', err);
      return false;
    }
  }

  // Call on page load
  await loadStackMetadata();
  ```

- [ ] Render photo row for upcoming tracks:
  ```javascript
  function renderPhotoRow(metadata) {
    // Display row of upcoming track photos with source labels
    const photoRow = document.getElementById('upcomingTracksRow');
    photoRow.innerHTML = '';

    sessionState.stack.forEach((item, index) => {
      const track = sessionState.trackMetadata[item.md5];
      if (!track) return;

      const photoCard = document.createElement('div');
      photoCard.className = 'upcoming-track';
      photoCard.innerHTML = `
        <img src="${track.imageUrl}" alt="${track.title}">
        <div class="track-info">
          <span class="title">${track.title}</span>
          <span class="artist">${track.artist}</span>
          <span class="source">${item.source}</span>
        </div>
      `;

      if (index === sessionState.stackIndex) {
        photoCard.classList.add('current');
      }

      photoRow.appendChild(photoCard);
    });
  }
  ```

- [ ] Implement force-insert logic:
  ```javascript
  function forceTrackFromStack(stackItem, explorerData) {
    const { md5, source } = stackItem;

    // Try suggested source first (if it's a direction)
    if (source && explorerData.directions[source]) {
      const tracks = explorerData.directions[source].sampleTracks;
      const trackIndex = tracks.findIndex(t => t.identifier === md5);

      if (trackIndex >= 0) {
        // Found in suggested direction - move to front
        const track = tracks.splice(trackIndex, 1)[0];
        tracks.unshift(track);
        explorerData.nextTrack = { directionKey: source, track };
        console.log(`🎯 Forced ${track.title} to front of ${source}`);
        return source;
      }
    }

    // Source not a direction or track not there - find ANY direction
    const anyDirection = findDirectionContainingTrack(explorerData, md5);

    if (anyDirection) {
      const tracks = explorerData.directions[anyDirection].sampleTracks;
      const trackIndex = tracks.findIndex(t => t.identifier === md5);
      const track = tracks.splice(trackIndex, 1)[0];
      tracks.unshift(track);
      explorerData.nextTrack = { directionKey: anyDirection, track };
      console.log(`🎯 Forced ${track.title} via ${anyDirection} (source: ${source})`);
      return anyDirection;
    }

    // CRITICAL ERROR - track validated on load but not in explorer
    console.error(`❌ FATAL: Track ${md5} not in explorer (source: ${source})`);
    showError(`Track not found in explorer - stopping playback`);
    sessionState.ephemeral = true; // Stop persisting
    throw new Error(`Track ${md5} missing from explorer`);
  }
  ```

- [ ] Update SSE handler for stack driving:
  ```javascript
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'track_started') {
      let explorerData = data.explorer;

      // Check if we have a named session with stack
      if (sessionState.stack.length > 0 &&
          sessionState.stackIndex < sessionState.stack.length - 1 &&
          !sessionState.ephemeral) {

        const nextStackItem = sessionState.stack[sessionState.stackIndex + 1];
        const track = sessionState.trackMetadata[nextStackItem.md5];
        console.log(`🎵 Stack wants: ${track.title} (source: ${nextStackItem.source})`);

        try {
          // Force-insert from stack (throws if track missing from explorer)
          const usedDirection = forceTrackFromStack(nextStackItem, explorerData);

          // Send to server
          sendNextTrack(nextStackItem.md5, usedDirection, 'session');

          // Update local state
          sessionState.stackIndex++;
          sessionState.positionSeconds = 0;

          // Persist to server (for resume)
          saveSessionPosition(sessionState.stackIndex, 0);

          // Update photo row to highlight current track
          renderPhotoRow(Object.values(sessionState.trackMetadata));
        } catch (err) {
          // Track missing from explorer - stop playback
          console.error('Stack playback failed:', err);
          return; // Don't update UI, audio will stop
        }
      }

      // Normal UI update
      createDimensionCards(explorerData);
      updateNowPlayingCard(data.currentTrack, data.driftState);
    }
  };
  ```

- [ ] Implement position saver:
  ```javascript
  async function saveSessionPosition(stackIndex, positionSeconds) {
    if (!sessionState.isPersistent) return; // Only save named sessions

    try {
      await fetch(`/session/${sessionState.sessionId}/position`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stackIndex, positionSeconds })
      });
      console.log(`💾 Saved position: track ${stackIndex}, ${positionSeconds}s`);
    } catch (err) {
      console.warn('Failed to save position:', err);
    }
  }
  ```

- [ ] Detect end of stack → ephemeral mode:
  ```javascript
  // In SSE handler, after checking stack
  if (sessionState.stackIndex >= sessionState.stack.length - 1) {
    if (!sessionState.ephemeral) {
      console.log('🌫️ End of stack - entering ephemeral mode');
      sessionState.ephemeral = true;
      // Show UI indicator?
      showEphemeralIndicator();
    }
  }
  ```

#### Testing Phase 0
- [ ] Batch fetch metadata for stack on page load
- [ ] Validate all tracks exist, show error if missing
- [ ] Render photo row with source labels
- [ ] Create named session: visit `/test-session`
- [ ] Verify session persists (refresh browser)
- [ ] Navigate via URL: `/test-session/3/45`
- [ ] Verify starts at track 3, 45 seconds in
- [ ] Watch playlist play through, generating explorer options as it goes
- [ ] Close browser, reopen `/test-session`
- [ ] Verify resumes at last position

---

### Phase 1: Import/Export (Week 2)
**Goal:** Build and save journeys programmatically

#### Server Tasks
- [ ] Implement `POST /session/:name/import`:
  ```javascript
  app.post('/session/:name/import', (req, res) => {
    const { stack } = req.body; // [{ md5, source }, ...]
    // Validate and create session with stack
    // Return URL to start session
  });
  ```

- [ ] Implement `GET /session/:name/export`:
  ```javascript
  app.get('/session/:name/export', (req, res) => {
    // Return { stack, stackIndex, positionSeconds, ... }
  });
  ```

- [ ] Implement `DELETE /session/:name/forget`:
  ```javascript
  app.delete('/session/:name/forget', (req, res) => {
    // Destroy session and remove from audioSessions
  });
  ```

- [ ] Implement `POST /session/:name/reset`:
  ```javascript
  app.post('/session/:name/reset', (req, res) => {
    // Clear stack, reset position to 0
  });
  ```

#### Client Tasks
- [ ] Add export button to UI
- [ ] Implement export flow (download JSON with full metadata for portability)

#### Testing Phase 1
- [ ] Export session as JSON
- [ ] Import JSON to new session name
- [ ] Verify stack identical
- [ ] Test `/forget` endpoint
- [ ] Test `/reset` endpoint

---

### Phase 2: Explorer Integration (Week 3)
**Goal:** Build stacks through exploration UI

#### Server Tasks
- [ ] Implement `/explore-from-track` endpoint (read-only, returns explorer data)

#### Client Tasks (from EXPLORER_STACK_DESIGN.md)
- [ ] Add `explorerStack` to state
- [ ] Implement layer push/pop/jump functions
- [ ] Add breadcrumb strip UI
- [ ] Wire ENTER key to push layer
- [ ] Wire ESC key to pop layer
- [ ] On track end: check explorerStack, force-insert if queued

#### Testing Phase 2
- [ ] Build 5-track queue in explorer
- [ ] Let tracks play through queue
- [ ] Verify force-insert works for each
- [ ] Save explorerStack as named session

---

### Phase 3: Stack Editing (Week 4)
**Goal:** Modify existing stacks

#### Server Tasks
- [ ] Implement `DELETE /session/:name/stack/:index` (adjust stackIndex if needed)
- [ ] Implement `PUT /session/:name/stack/:index/move` (reorder, adjust stackIndex)
- [ ] Implement `POST /session/:name/stack/:index/insert` (insert {md5, source})

#### Client Tasks
- [ ] Add stack editor UI with drag-to-reorder, remove, and insert

#### Testing Phase 3
- [ ] Remove track from middle of stack
- [ ] Verify stackIndex adjusts
- [ ] Reorder tracks (drag)
- [ ] Insert new track
- [ ] Play through edited stack

---

### Phase 4: Analytics & History (Week 5)
**Goal:** Track and export journey data

#### Server Tasks (from EXPLORER_STACK_DESIGN.md)
- [ ] Add `history` array to session state
- [ ] Implement `recordTransition()` on track change
- [ ] Implement `GET /session/:name/report`
- [ ] Implement `GET /session/:name/report/csv`

#### Client Tasks
- [ ] Add session report viewer modal
- [ ] Show statistics (distances, direction distribution)
- [ ] Add CSV export button

#### Testing Phase 4
- [ ] Play 10-track session
- [ ] Generate report
- [ ] Verify all transitions logged
- [ ] Export CSV, open in spreadsheet

---

### Phase 5: External Algorithms (Week 6+)
**Goal:** Programmatic stack generation

#### Server Tasks
- [ ] Implement `/api/kdtree/neighbors/:md5`
- [ ] Implement `/api/path/shortest?from=:md5&to=:md5` (returns stack with source='journey')
- [ ] Implement `/api/path/timed?from=:md5&to=:md5&duration=:seconds`
- [ ] Implement `/api/explore/centroid?duration=:seconds`

#### Testing Phase 5
- [ ] Generate shortest path A→B
- [ ] Import to named session
- [ ] Play through computed path with source='journey'
- [ ] Verify smooth transitions

---

## Quick Reference: Key Files to Modify

### Server-Side
1. **`server.js`**
   - Add `/:name`, `/:name/:index/:seconds` routes
   - Add import/export/forget/reset endpoints
   - Add stack editing endpoints
   - Update session cleanup logic

2. **`drift-audio-mixer.js`**
   - Add stack properties to constructor
   - NO logic changes (client drives everything)

3. **`radial-search.js`** (or equivalent)
   - Implement `/explore-from-track` method

### Client-Side
4. **`page.js`**
   - Read `window.sessionState`
   - Implement force-insert logic
   - Update SSE handler for stack driving
   - Add position saver
   - Detect ephemeral mode

5. **`index.html`**
   - Add stack editor UI elements
   - Add export/import buttons

### New Files
6. **`session-manager.js`** (optional helper)
   - Encapsulate session CRUD operations
   - Stack manipulation helpers

---

## Success Metrics

**Phase 0:** ✅ Can visit `/myname/4/20`, resumes at track 4, 20s
**Phase 1:** ✅ Can export/import stack JSON
**Phase 2:** ✅ Can build stack in explorer, auto-plays
**Phase 3:** ✅ Can edit stack (remove/reorder)
**Phase 4:** ✅ Can generate CSV report of journey
**Phase 5:** ✅ Can import algorithmic stack (shortest path)

---

## Notes

- **Source is storytelling metadata:** Can be direction ('bpm_positive') or label ('playlist', 'journey', 'manual')
- **Track validation on load:** Batch metadata fetch validates all MD5s exist, stops playback if corrupted
- **Photo row UI:** Display upcoming tracks with source labels, watch explorer generate options as playlist plays
- **Client is king:** Server stores, client drives
- **URL navigation writes state:** `/name/4/20` modifies session, then serves page
- **Named sessions never expire:** Manual `/forget` only
- **Ephemeral mode:** Client detects end of stack, stops persisting
- **Critical errors stop playback:** If track missing from explorer, throw error and stop (better than wrong track)

**Ready to implement!**
