# Session Design Audit: Named Sessions vs Explorer Stack

**Date:** 2025-10-02
**Purpose:** Cross-reference NAMED_SESSIONS_DESIGN.md against EXPLORER_STACK_DESIGN.md to identify conflicts, overlaps, and integration opportunities

---

## Executive Summary

Both designs describe **stack-based journey tracking** but from different perspectives:

- **EXPLORER_STACK_DESIGN.md** (Oct 1): Client-side speculative playlist builder with layer exploration
- **NAMED_SESSIONS_DESIGN.md** (Oct 2): Server-side persistent sessions with stack-based journeys

**Key Finding:** These are **complementary, not conflicting**. The explorer stack is the *client-side UX* for building what becomes the *server-side named session state*.

---

## Core Concepts Comparison

### Stack Structure

**EXPLORER_STACK** (Client):
```javascript
[
  {
    layerId: "layer_1234_0",
    seedTrack: { identifier, title, artist, albumCover, variant },
    explorerData: { directions, nextTrack, outliers },
    uiState: { selectedDirectionKey, selectedIdentifier, stackIndex, ... },
    timestamp: 1234567890,
    parentLayerId: "layer_1234_parent"
  },
  // ... more layers
]
```

**NAMED_SESSION** (Server):
```javascript
{
  sessionId: "myname",
  stack: [
    { md5: "abc123...", direction: null },
    { md5: "def456...", direction: "bpm_positive" },
    // ... more tracks
  ],
  stackIndex: 2,
  positionSeconds: 45,
  ephemeral: false
}
```

### Key Differences

| Aspect | Explorer Stack | Named Session |
|--------|---------------|---------------|
| **Location** | Client-side only | Server-side persistent |
| **Storage** | In-memory, layer objects | In-memory, minimal (md5, direction) |
| **Persistence** | localStorage for playlists | Indefinite in server memory |
| **Granularity** | Full explorer data cached | Just track ID + incoming direction |
| **Position** | Not tracked | stackIndex + positionSeconds |
| **Purpose** | Speculative exploration UI | Playback state + resume |

### Critical Insight

**The explorer stack's `seedTrack.identifier` + incoming direction = Named session's `{ md5, direction }` pair!**

They represent the **same concept** at different layers:
- **Client**: Rich layer with full explorer data for UX
- **Server**: Minimal pair for replay/resume

---

## URL Routing Conflicts

### EXPLORER_STACK Routes
- **/explore-from-track** (POST) - Fetch explorer for arbitrary track (read-only)
- **/next-track** (POST) - Commit track selection (with `source` field)
- **/session/:sessionId/report** (GET) - Session analytics
- **/session/:sessionId/report/csv** (GET) - CSV export

### NAMED_SESSION Routes
- **/:md5** - MD5-seeded session (32 hex chars)
- **/:md51/:md52** - Contrived journey (2 MD5s)
- **/name** - Named session (< 32 chars)
- **/name/index** - Jump to stack position
- **/name/index/seconds** - Jump to position + time
- **/name/export** - Export session JSON
- **/name/forget** - Delete session
- **/name/reset** - Clear stack

### Resolution: **NO CONFLICTS**

Routes are complementary:
- Named session routes handle **session lifecycle** (create, resume, navigate)
- Explorer stack routes handle **exploration mechanics** (fetch data, commit selections, reports)

**Integration point:** Named session `/name` could use `/explore-from-track` to build initial state.

---

## Stack Building: Two Modes

### Mode 1: Client-Driven (Explorer Stack)

```javascript
// User explores in UI
1. User presses ENTER on track B
2. Client calls: POST /explore-from-track { trackMd5: B }
3. Client pushes layer to explorerStack
4. Client does NOT update server session yet

// Track ends, force insert
5. SSE fires, track A ends
6. Client pops explorerStack[0] → layer with seedTrack: B
7. Client finds B in server's explorer
8. Client calls: POST /next-track { trackMd5: B, direction: "bpm_positive", source: "playlist" }
9. Server updates drift state, B plays
```

**Stack lives in:** Client only (until track actually plays)
**Server sees:** Individual `/next-track` calls (no knowledge of queue)

### Mode 2: Server-Driven (Named Session)

```javascript
// Session created with pre-built stack
1. POST /session/myname/import { stack: [{ md5: A }, { md5: B, direction: "bpm_positive" }] }
2. Server stores: session.stack = [A, B]
3. Server sets: stackIndex = 0, positionSeconds = 0

// Playback
4. Client visits /myname
5. Server serves HTML, client connects SSE/audio
6. Server loads track from stack[stackIndex]
7. When track ends, server increments stackIndex
8. Server loads stack[stackIndex].md5 via stack[stackIndex].direction
```

**Stack lives in:** Server (persistent state)
**Client sees:** SSE events (normal flow)

---

## Integration Strategy

### Unified Model: "Stack as Truth"

```javascript
// Server-side session
{
  sessionId: "myname",

  // CORE: The journey stack
  stack: [
    { md5: "abc...", direction: null },
    { md5: "def...", direction: "bpm_positive" },
  ],

  // PLAYBACK: Current position
  stackIndex: 1,
  positionSeconds: 45,

  // LIFECYCLE: Modes
  ephemeral: false,  // true = don't save changes

  // ANALYTICS: Full history (includes played tracks)
  history: [...],  // From EXPLORER_STACK_DESIGN
}
```

### Client-Side State

```javascript
// Client maintains rich exploration UI
{
  explorerStack: [
    {
      seedTrack: { identifier: "abc..." },
      explorerData: { ... },
      uiState: { ... }
    },
    // ... more layers
  ],
  activeLayerIndex: 1,

  // LINK TO SERVER: Current session
  sessionId: "myname",
  serverStack: null,  // Synced from server
}
```

### Sync Flow

**On session load (`/myname`):**
1. Server sends stack in SSE: `{ stack: [...], stackIndex: 1, positionSeconds: 45 }`
2. Client builds explorerStack by calling `/explore-from-track` for each item
3. Client sets activeLayerIndex = stackIndex

**On track end (organic exploration):**
1. Client pops explorerStack[0]
2. Client calls `/next-track` with md5 + direction
3. Server updates stackIndex++ (if not ephemeral)
4. Server saves positionSeconds = 0

**On track end (named session replay):**
1. Server checks: stackIndex < stack.length?
2. If yes: load stack[stackIndex], increment stackIndex
3. If no: flip ephemeral = true, continue with drift

---

## Feature Reconciliation

### What EXPLORER_STACK Has That NAMED_SESSION Needs

1. **`/explore-from-track` endpoint** ✅ (MUST IMPLEMENT)
   - Named sessions need this to build explorer data for stack items

2. **Session history tracking** ✅ (MUST IMPLEMENT)
   - Already in EXPLORER_STACK as `session.history[]`
   - Named sessions should adopt this for analytics

3. **Transition metadata** ✅ (MUST IMPLEMENT)
   - `{ fromTrackMd5, primaryDiscriminator, chosenDirection, distance, transitionType }`
   - Named sessions should record this

4. **CSV/JSON export** ✅ (NICE TO HAVE)
   - `/session/:id/report` and `/session/:id/report/csv`

### What NAMED_SESSION Has That EXPLORER_STACK Needs

1. **Persistent server state** ✅ (KEY ADDITION)
   - Explorer stack is ephemeral (in-memory only)
   - Named sessions persist in server memory indefinitely

2. **Position tracking** ✅ (KEY ADDITION)
   - `stackIndex` + `positionSeconds` missing from EXPLORER_STACK
   - Essential for resume functionality

3. **URL navigation** ✅ (KEY ADDITION)
   - `/name/index/seconds` allows direct jump
   - Explorer stack has no concept of position jumping

4. **Ephemeral mode** ✅ (KEY ADDITION)
   - After stack exhausted, stop persisting
   - Explorer stack doesn't handle "end of queue"

5. **Import/export** ✅ (OVERLAPS)
   - Both designs have import/export
   - Named session export is simpler (just `[(md5, direction)]`)
   - Explorer stack export is richer (includes UI state)

---

## Conflict Resolution

### 1. Stack Format Mismatch

**CONFLICT:**
- Explorer: `[{ layerId, seedTrack, explorerData, uiState }]`
- Named: `[{ md5, direction }]`

**RESOLUTION:**
```javascript
// Server stores minimal:
session.stack = [
  { md5: "abc...", direction: null },
  { md5: "def...", direction: "bpm_positive" }
]

// Client builds rich layers on-demand:
async function hydrateStackFromServer(serverStack) {
  const explorerStack = [];
  for (const { md5, direction } of serverStack) {
    const explorerData = await fetch('/explore-from-track', { trackMd5: md5 });
    explorerStack.push({
      seedTrack: { identifier: md5, ... },
      explorerData,
      uiState: { selectedDirectionKey: direction || null, ... }
    });
  }
  return explorerStack;
}
```

**Principle:** Server is source of truth (minimal), client hydrates for UX (rich).

### 2. Position Tracking Confusion

**CONFLICT:**
- Explorer: `activeLayerIndex` (which layer user is editing)
- Named: `stackIndex` (which track is playing)

**RESOLUTION:**
These are **different concepts**:
- `stackIndex` = server playback position (which track playing)
- `activeLayerIndex` = client exploration position (which layer viewing)

When exploring ahead, `activeLayerIndex > stackIndex` (user is previewing future tracks).

```javascript
// Example: Playing track 2, exploring track 5
session.stackIndex = 2           // Server: track 2 playing
state.activeLayerIndex = 5       // Client: viewing layer 5
```

### 3. Playlist vs. Session Terminology

**CONFLICT:**
- Explorer uses "playlist" (save/load from localStorage)
- Named uses "session" (server memory, indefinite)

**RESOLUTION:**
Unify as **"Named Journey"**:
- **Named Session** = server-side persistent state
- **Playlist** = exported/imported JSON (portable)
- **Explorer Stack** = client-side preview/editing UI

```
Named Session (server)  ←→  Explorer Stack (client)  ←→  Playlist (export)
     (persistent)              (ephemeral UI)            (portable JSON)
```

### 4. Export Format Collision

**CONFLICT:**
- Explorer playlist: `{ version, created, name, tracks: [{ identifier, title, artist, ... }] }`
- Named session export: `{ name, stack: [{ md5, direction }], stackIndex, positionSeconds, ... }`

**RESOLUTION:**
**Two export types:**

**Playlist Export** (portable, shareable):
```json
{
  "version": 1,
  "name": "My Journey",
  "tracks": [
    { "identifier": "abc...", "title": "...", "artist": "..." }
  ]
}
```
→ Loses direction metadata, UI-friendly

**Session Export** (full state, resume):
```json
{
  "sessionId": "myname",
  "stack": [
    { "md5": "abc...", "direction": null },
    { "md5": "def...", "direction": "bpm_positive" }
  ],
  "stackIndex": 2,
  "positionSeconds": 45,
  "created": "2025-10-02T..."
}
```
→ Preserves exact state for resume

---

## Proposed Unified Architecture

### Server State (Named Session)

```javascript
class NamedSession {
  sessionId: string               // "myname" or "abc123..." (MD5)
  stack: Array<{                  // Journey as (md5, direction) pairs
    md5: string,
    direction: string | null      // How we got here (null for first)
  }>
  stackIndex: number              // Current playback position
  positionSeconds: number         // Position within current track
  ephemeral: boolean              // Stop persisting after stack ends

  // Analytics (from EXPLORER_STACK)
  history: Array<{                // Full transition log
    timestamp: number,
    trackMd5: string,
    transitionInfo: { ... },
    explorerSnapshot: { ... }
  }>

  // Lifecycle
  created: Date
  lastAccess: Date
  isPersistent: boolean           // true for named, false for MD5/anonymous
}
```

### Client State (Explorer Stack)

```javascript
{
  // Rich UI layers (ephemeral)
  explorerStack: Array<{
    layerId: string,
    seedTrack: { identifier, title, artist, albumCover },
    explorerData: { directions, nextTrack, outliers },
    uiState: { selectedDirectionKey, selectedIdentifier, stackIndex, ... }
  }>,

  // Editing position
  activeLayerIndex: number,       // Which layer user is viewing/editing

  // Link to server
  sessionId: string,              // Current named session
  serverStackIndex: number,       // Where server playback is (synced via SSE)

  // Modes
  explorerActive: boolean,        // Exploration UI visible
  ephemeral: boolean              // Synced from server
}
```

### API Endpoints (Unified)

**Session Lifecycle:**
- `GET /:name` → Load/resume named session (< 32 chars)
- `GET /:md5` → Load MD5-seeded session (= 32 hex chars)
- `GET /:md51/:md52` → Load contrived journey (2 MD5s)
- `GET /:name/:index` → Jump to stack position
- `GET /:name/:index/:seconds` → Jump to position + time
- `POST /session/:name/import` → Import stack JSON
- `GET /session/:name/export` → Export session state
- `DELETE /session/:name/forget` → Delete session
- `POST /session/:name/reset` → Clear stack

**Exploration:**
- `POST /explore-from-track` → Fetch explorer for arbitrary track (read-only)
- `POST /next-track` → Commit track (with `source: 'user' | 'playlist' | 'session'`)

**Analytics:**
- `GET /session/:sessionId/report` → Full session report JSON
- `GET /session/:sessionId/report/csv` → CSV export

**External Algorithms:**
- `GET /api/kdtree/neighbors/:md5?k=20` → Nearest neighbors
- `GET /api/path/:algorithm?from=:md5&to=:md5` → Computed paths

---

## Integration Scenarios

### Scenario 1: Build Playlist in Explorer, Save as Named Session

```javascript
// 1. User explores in UI (explorer stack)
explorerStack = [A, B, C, D]
activeLayerIndex = 3

// 2. User saves as named session
POST /session/my-journey/import
Body: {
  stack: [
    { md5: "A...", direction: null },
    { md5: "B...", direction: "bpm_positive" },
    { md5: "C...", direction: "entropy_negative" },
    { md5: "D...", direction: "tonal_clarity_positive" }
  ]
}

// 3. Server creates persistent session
session = {
  sessionId: "my-journey",
  stack: [...],
  stackIndex: 0,
  positionSeconds: 0,
  isPersistent: true
}

// 4. User visits /my-journey tomorrow
// Server resumes at stackIndex 0, positionSeconds 0
```

### Scenario 2: Load Named Session, Continue Exploring

```javascript
// 1. User visits /my-journey
GET /my-journey
Server: stackIndex = 2, stack = [A, B, C, D]

// 2. SSE sends: { stack: [...], stackIndex: 2 }
// Client hydrates explorerStack by calling /explore-from-track

// 3. User opens explorer (/)
explorerActive = true
activeLayerIndex = 2  // Start from current position

// 4. User explores beyond track D → E
explorerStack.push(E)
activeLayerIndex = 4

// 5. User closes explorer (ESC)
explorerActive = false
// explorerStack kept in memory (not saved to server yet)

// 6. Track ends, client force-inserts E
POST /next-track { trackMd5: E, direction: "...", source: "playlist" }

// 7. Server appends E to stack (if not ephemeral)
session.stack.push({ md5: E, direction: "..." })
session.stackIndex = 3
```

### Scenario 3: Algorithmic Playlist Import

```javascript
// 1. External script computes path
curl /api/path/shortest?from=abc&to=def
Response: { path: [
  { md5: "abc...", direction: null },
  { md5: "mid...", direction: "bpm_positive" },
  { md5: "def...", direction: "entropy_negative" }
]}

// 2. Import to named session
POST /session/shortest-path/import
Body: { stack: path }

// 3. User visits /shortest-path
// Plays through computed path
// When exhausted, flips ephemeral = true
```

---

## Implementation Checklist

### Phase 1: Core Named Session (Server)
- [ ] Add `stack`, `stackIndex`, `positionSeconds` to session state
- [ ] Add `ephemeral` flag and transition logic
- [ ] Implement `/name`, `/name/index`, `/name/index/seconds` routes
- [ ] Update session cleanup (named = indefinite retention)
- [ ] Implement `/session/:name/import` and `/session/:name/export`

### Phase 2: Explorer Integration (Server)
- [ ] Implement `/explore-from-track` endpoint (from EXPLORER_STACK)
- [ ] Add session history tracking (from EXPLORER_STACK)
- [ ] Update `/next-track` to record transitions
- [ ] Implement stack auto-advance on track end

### Phase 3: Client Hydration
- [ ] On named session load, fetch explorer data for stack items
- [ ] Build explorerStack from server stack
- [ ] Sync activeLayerIndex with stackIndex
- [ ] Handle SSE updates for stackIndex changes

### Phase 4: Explorer Stack UI (from EXPLORER_STACK)
- [ ] Implement layer push/pop/jump
- [ ] Add breadcrumb strip
- [ ] Wire keyboard shortcuts (ENTER/ESC/arrows)
- [ ] Implement force-insert logic on track end

### Phase 5: Persistence
- [ ] Save explorerStack to localStorage as "draft"
- [ ] Add "Save as Named Session" button → POST /session/:name/import
- [ ] Add "Export Playlist" → simplified JSON (no directions)
- [ ] Add "Export Session" → full state JSON (with directions)

### Phase 6: Analytics (from EXPLORER_STACK)
- [ ] Generate session reports (JSON/CSV)
- [ ] Track transition metadata (discriminator, distance, type)
- [ ] Add report viewer modal

---

## Open Questions

### 1. Stack Growth Limit?
**EXPLORER_STACK:** Assumes unlimited growth
**NAMED_SESSION:** Assumes unlimited for named, cleanup for anonymous

**DECISION NEEDED:** Should named sessions have a max stack size (e.g., 1000 tracks)?

### 2. Direction on First Track?
**EXPLORER_STACK:** First track has no incoming direction (null)
**NAMED_SESSION:** Same (null)

**CONFIRMED:** Aligned ✅

### 3. Ephemeral Mode Trigger?
**NAMED_SESSION:** When `stackIndex >= stack.length - 1 && trackEnded`
**EXPLORER_STACK:** Not addressed

**DECISION:** Use NAMED_SESSION approach - flip ephemeral when stack exhausted.

### 4. History vs. Stack?
**EXPLORER_STACK:** `session.history[]` includes all played tracks
**NAMED_SESSION:** `session.stack[]` is the journey plan (may not all play)

**CLARIFICATION NEEDED:**
- Is `stack` the **plan** (what should play)?
- Is `history` the **log** (what actually played)?
- If user jumps to stackIndex 5, does history show jump or just track 5?

**PROPOSAL:**
```javascript
session.stack = [A, B, C, D, E]     // The journey (plan)
session.stackIndex = 2              // Currently at C
session.history = [                 // What actually played
  { trackMd5: A, ... },
  { trackMd5: B, ... },
  { trackMd5: C, ... },             // Only up to current
  // D, E not in history yet (not played)
]
```

### 5. Client Authority on Stack?
**EXPLORER_STACK:** Client builds stack, server sees individual transitions
**NAMED_SESSION:** Server owns stack, client follows

**CONFLICT:** Who decides stack contents?

**PROPOSAL:**
- **Named sessions:** Server owns stack (loaded from URL/import)
- **Explorer mode:** Client builds stack, pushes to server on save
- **Hybrid:** Client can speculatively extend server stack (ephemeral until saved)

---

## Recommendations

### 1. Adopt NAMED_SESSION as Foundation
- Server-side stack is source of truth
- Enables resume, sharing, algorithmic generation
- Persistent storage superior to client-only localStorage

### 2. Use EXPLORER_STACK as Client UX
- Rich layer UI for exploration
- Breadcrumb navigation
- Speculative preview (doesn't commit to server until track plays)

### 3. Implement Both Export Formats
- **Playlist Export:** Simple, UI-friendly, portable
- **Session Export:** Full state, exact resume

### 4. Unify Position Semantics
- `stackIndex` = playback position (server authority)
- `activeLayerIndex` = exploration position (client only)
- `stackIndex ≤ activeLayerIndex` always (can't play future tracks)

### 5. Add Server→Client Stack Sync
```javascript
// SSE event when server updates stack
{
  type: 'stack_updated',
  stack: [...],
  stackIndex: 2,
  positionSeconds: 45,
  ephemeral: false
}
```

Client updates explorerStack to match (re-hydrate if needed).

---

## Final Architecture Summary

### Data Flow

```
┌─────────────────────────────────────────────────────┐
│                   CLIENT                             │
│  ┌──────────────────────────────────────────────┐   │
│  │  Explorer Stack (Rich UI Layers)             │   │
│  │  [layerId, seedTrack, explorerData, uiState] │   │
│  │  activeLayerIndex = 3                        │   │
│  └──────────────────────────────────────────────┘   │
│                       ↕                              │
│              Hydrate from server                     │
│              Force-insert on track end               │
│                       ↕                              │
└─────────────────────────────────────────────────────┘
                        ↕
              SSE / POST /next-track
                        ↕
┌─────────────────────────────────────────────────────┐
│                   SERVER                             │
│  ┌──────────────────────────────────────────────┐   │
│  │  Named Session (Persistent State)            │   │
│  │  stack: [{ md5, direction }]                 │   │
│  │  stackIndex: 2, positionSeconds: 45          │   │
│  │  ephemeral: false, history: [...]            │   │
│  └──────────────────────────────────────────────┘   │
│                       ↕                              │
│              /explore-from-track (read-only)         │
│              /session/:name/import (write)           │
│                       ↕                              │
└─────────────────────────────────────────────────────┘
                        ↕
              External Algorithms
                        ↕
                /api/path/:algorithm
```

### Terminology

| Term | Definition | Location |
|------|------------|----------|
| **Named Session** | Server-side persistent journey state | Server memory |
| **Explorer Stack** | Client-side rich preview/editing UI | Browser memory |
| **Playlist** | Exported JSON (portable, simplified) | File/localStorage |
| **Stack** | Array of (md5, direction) pairs | Server |
| **Layer** | Rich UI object with explorer data | Client |
| **stackIndex** | Current playback position | Server |
| **activeLayerIndex** | Current exploration position | Client |
| **Ephemeral Mode** | Stop persisting changes | Both |

---

## Conclusion

**VERDICT:** The designs are **compatible and complementary**.

- **EXPLORER_STACK_DESIGN.md** focuses on **client-side UX** for speculative playlist building
- **NAMED_SESSIONS_DESIGN.md** focuses on **server-side persistence** for resumable journeys

**Integration path:**
1. Implement NAMED_SESSION server state first (foundation)
2. Implement /explore-from-track endpoint (bridge)
3. Implement EXPLORER_STACK client UI (builds on foundation)
4. Add session import/export (connects both)
5. Add external algorithms API (extends capabilities)

**Result:** Users can:
- Explore speculatively in rich UI (Explorer Stack)
- Save journeys as named sessions (Named Session)
- Resume exactly where they left off (stackIndex + positionSeconds)
- Import algorithmic playlists (External tools → Named Session)
- Export for sharing (Playlist JSON or Session JSON)

**No conflicts found.** Proceed with unified implementation.

---

**END OF AUDIT**
