# Named Sessions & Stack-Based Journey Design

## Core Concept

Named sessions provide persistent, resumable journeys through the music space. Each session maintains a **stack** (journey history/playlist), current position within that stack, and playback position within the current track.

## Session State Model

```javascript
{
  sessionId: "myname",              // Session identifier
  stack: [                          // Journey as sequence of (track, direction) pairs
    { md5: "abc123...", scope: 'magnify', direction: null },           // Seed track (no incoming direction)
    { md5: "def456...", scope: 'magnify', direction: "bpm_positive" }, // Reached via bpm_positive from previous
    { md5: "ghi789...", scope: 'micro', direction: "entropy_negative" }, // Reached via entropy- from previous at microscope scope
    // ... continues as user explores or pre-loaded playlist
  ],
  stackIndex: 2,                    // Currently on 3rd track (0-indexed)
  positionSeconds: 45,              // 45 seconds into current track
  ephemeral: false,                 // true when past end of stack (stop persisting)
  created: "2025-10-02T...",        // Session creation timestamp
  lastAccess: Date,                 // For cleanup (named = indefinite retention)
}
```

### Direction Semantics
The `direction` field represents **how we arrived at this track from the previous one**:
- `null` for first track (seed/starting point)
- Explorer direction key (e.g., `"bpm_positive"`, `"entropy_negative"`) for tracks via card clock search
- Preserves the "journey path" for UI visualization and replay

### Scope Semantics
- `micro|magnify|tele` for tracks chosen by search
- `jump` for tracks injected into the playlist in defiance of the search payload

## URL Routes

### Named Session Access
- **`/myname`** → Load/resume session "myname" at saved position
  - If new: create empty session
  - If exists: resume at `stackIndex` and `positionSeconds`

### Position Navigation
- **`/myname/4`** → Jump to index 4 (5th track) in stack, start from beginning
  - Updates `stackIndex = 4`
  - Sets `positionSeconds = 0`
  - Persists new position to session

- **`/myname/4/20`** → Jump to index 4, start at 20 seconds in
  - Updates `stackIndex = 4`
  - Sets `positionSeconds = 20`
  - Persists new position to session

### Session Management
- **`/myname/forget`** → Delete session from memory entirely
- **`/myname/reset`** → Clear stack, reset position (keep session name)
- **`/myname/export`** → Export session state as JSON

### Route Pattern Recognition
- Named sessions: any string **< 32 characters** (won't clash with MD5)
- MD5 routes: exactly **32 hexadecimal characters**
- Combined: `/md51/md52` (two 32-char MD5s)

## Session Lifecycle

### 1. Named Sessions (Persistent)
- **Infinite retention** in memory (until `/myname/forget`)
- Always save position on state change
- Survive disconnection/reconnection within 60min keepalive
- No automatic cleanup

### 2. Organic Stack Building (Exploring)
```javascript
// User clicks next track via bpm_positive direction
stack.push({
  md5: "new_track_md5",
  direction: "bpm_positive"
})
stackIndex++
positionSeconds = 0
saveSessionState() // Persist to named session
```

### 3. Replay Mode (URL Navigation)
```javascript
// Visit /myname/4/20
stackIndex = 4
positionSeconds = 20
// Stack unchanged, just navigation pointer
saveSessionState() // Persist new position
```

### 4. Ephemeral Mode (End of Stack)
When playback reaches end of stack:
```javascript
if (stackIndex >= stack.length - 1 && trackEnded) {
  session.ephemeral = true  // Stop persisting changes
  // Continue allowing exploration, but:
  // - New tracks don't append to stack
  // - Position changes not saved
  // - Essentially "browsing privately" after playlist ends
}
```

## Stack as Universal Format

**Key Insight:** Any journey/playlist compiles to the same simple structure:
```javascript
[
  { md5: "track1", scope: 'magnify', direction: null },
  { md5: "track2", scope: 'magnify', direction: "how_we_got_here" },
  { md5: "track3", scope: 'micro', direction: "how_we_got_here" },
]
```

This enables:
1. **Organic exploration** → builds stack naturally
2. **Forced replay** → navigate pre-built stack
3. **Algorithmic generation** → external tools create stacks
4. **Sharing/export** → portable journey format

## External Playlist Generation

### Philosophy
"Language → DSL → API → Playlist" happens **outside the player**

The player only needs to:
1. Import a stack
2. Navigate through it
3. Export for sharing

### Example Use Cases

**Shortest Path** (graph algorithm):
```bash
curl /api/path/shortest?from=abc123&to=def456
# Returns optimal path through feature space
POST /session/shortest-path/import < stack.json
# Visit /shortest-path to play
```

**Timed Journey** (constraint solver):
```bash
curl /api/path/timed?from=abc123&to=def456&duration=4200
# Returns path fitting exactly 70 minutes
POST /session/commute/import < stack.json
```

**Statistical Exploration** (analytics):
```bash
curl /api/explore/centroid?duration=7200
# Finds 2 hours near feature-space center (most "average")
POST /session/baseline/import < stack.json
```

**Two-Track Journeys** (like `/md51/md52`):
Just special case of stack with 2 elements - any path generation fits the model.

## API Endpoints (Future)

### KdTree Query API (Read-Only, External Tools)
```
GET  /api/kdtree/neighbors/:md5?k=20           # Nearest neighbors
GET  /api/kdtree/search?feature=bpm&value=120  # Parametric search
GET  /api/kdtree/stats                         # Feature distributions
GET  /api/path/:algorithm?from=:md5&to=:md5    # Computed paths
     algorithms: shortest, timed, scenic, random_walk, centroid, etc.
```

### Session Import/Export
```
POST   /session/:name/import                   # Body: { stack: [...] }
GET    /session/:name/export                   # Returns full session state
DELETE /session/:name/forget                   # Purge session
POST   /session/:name/reset                    # Clear stack, keep name
```

### Export Format
```json
{
  "name": "myname",
  "stack": [
    { "md5": "abc123...", "direction": null },
    { "md5": "def456...", "direction": "bpm_positive" }
  ],
  "stackIndex": 1,
  "positionSeconds": 45,
  "created": "2025-10-02T16:30:00Z",
  "duration": 3600,
  "trackCount": 12,
  "shareUrl": "/myname"
}
```

## Implementation Strategy

### Phase 1: Core Session State
1. Add stack structure to `DriftAudioMixer`:
   ```javascript
   this.stack = [];           // Journey history
   this.stackIndex = 0;       // Current position in stack
   this.positionSeconds = 0;  // Position in current track
   this.ephemeral = false;    // Persistence flag
   ```

2. Update session cleanup logic:
   - Named sessions (non-MD5 IDs): **never** auto-cleanup
   - MD5/anonymous sessions: existing 60min timeout

### Phase 2: Named Session Routes
1. `/name` route with session create/resume logic
2. `/name/index/seconds` route for position jumping
3. Session state persistence on position changes

### Phase 3: Stack Navigation
1. Track selection appends to stack (organic mode)
2. URL navigation updates stackIndex/position (replay mode)
3. End-of-stack → ephemeral mode transition

### Phase 4: Import/Export
1. Export endpoint (serialize session state)
2. Import endpoint (deserialize and load)
3. Forget/reset endpoints

### Phase 5: KdTree API (External Tools)
1. Query endpoints for neighbors, search
2. Path algorithm endpoints (shortest, timed, etc.)
3. Statistics/metadata endpoints

## Benefits

### For Users
- **Resume anywhere**: Sessions persist position exactly
- **Share journeys**: Export stack, share URL
- **Curated playlists**: Pre-build journeys algorithmically

### For Developers
- **Simple format**: Stack is just `[(md5, direction)]`
- **Composable**: Any tool can generate valid stacks
- **Debuggable**: Journey is explicit list, not implicit state

### For the System
- **Deterministic**: Same stack + index = same state
- **Portable**: Export/import for backup/sharing
- **Extensible**: Add new path algorithms without changing player

## Examples in Practice

### Scenario 1: Organic Exploration
1. User visits `/jazz-exploration`
2. Clicks through 12 tracks organically
3. Closes browser at track 7, 2:15 in
4. Returns to `/jazz-exploration` tomorrow
5. Resumes at track 7, 2:15 exactly

### Scenario 2: Algorithmic Playlist
1. External script computes "most average 2 hours"
2. Posts stack to `/session/average/import`
3. User visits `/average` to listen
4. Navigates to `/average/5/30` to jump to specific point

### Scenario 3: Journey Sharing
1. User explores and finds great path from jazz→techno
2. Exports via `/my-transition/export`
3. Shares JSON with friend
4. Friend imports to `/their-copy/import`
5. Both can replay same journey

### Scenario 4: Shortest Path Between Tracks
1. "I want to get from Miles Davis to Aphex Twin"
2. External tool: `/api/path/shortest?from=abc&to=def`
3. Returns 8-track path through feature space
4. Import to `/miles-to-aphex`
5. Play and hear the "bridge" between genres

## Notes for Implementation

- Session state saved on every position change (track change, seek, stack navigation)
- SSE broadcasts include stack context: `{ currentTrack, stackIndex, stackLength }`
- Frontend shows "Track 4/12" when playing from stack
- Ephemeral mode shows indicator: "Exploring (not saved)"
- Export includes full metadata for sharing/debugging
- Import validates stack (all MD5s exist in kdTree)

## Open Questions

1. **Stack size limit?** Or unlimited growth for named sessions?
2. **Ephemeral mode UI:** How to indicate "past the end" state?
3. **Stack editing:** Allow removing/reordering via API?
4. **Collaborative sessions:** Multiple users same named session?
