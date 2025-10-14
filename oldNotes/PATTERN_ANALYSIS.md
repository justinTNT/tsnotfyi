# Software Pattern Analysis & Implementation Audit

## Executive Summary

This analysis identifies 9 major software patterns in the tsnotfyi codebase, rates their implementation completeness, and prioritizes improvements. **3 patterns are critically incomplete** and represent both risks and opportunities for quick wins.

---

## Pattern Inventory & Ratings

### 1. ✅ **Singleton Pattern** (90% Complete)
**Location**: `server.js:45-82`
**Implementation**: PID-file based server instance locking
**Strengths**:
- Process-level singleton with stale PID cleanup
- Proper exit handlers
- Clear error messages

**Gaps**:
- No graceful shutdown coordination with active sessions

**Risk**: Low
**Priority**: P3 - Nice to have

---

### 2. ⚠️ **Event-Driven Architecture (Observer Pattern)** (45% Complete)
**Locations**:
- `drift-audio-mixer.js:67-114` (callbacks)
- `advanced-audio-mixer.js:65-69` (callbacks)

**Current State**:
- ✅ Callback-based events: `onData`, `onTrackStart`, `onTrackEnd`, `onCrossfadeStart`
- ✅ SSE broadcast mechanism for client updates
- ❌ No standardized event emitter pattern
- ❌ Callbacks assigned ad-hoc, not centralized
- ❌ No event lifecycle management
- ❌ Error events not consistently handled

**Risks**:
- Callbacks can be overwritten accidentally
- No guarantee of event delivery order
- Hard to debug event flow
- Memory leaks if cleanup not manual

**Opportunity**:
Convert to EventEmitter pattern for type safety, better debugging, and multiple listeners

**Priority**: **P1 - Critical** (affects reliability)

---

### 3. 🔴 **State Synchronization Pattern** (35% Complete)
**Locations**:
- Client: `page.js:2460-2577` (heartbeat + state tracking)
- Server: `drift-audio-mixer.js` (currentTrack, nextTrack, session state)

**Current State**:
- ✅ Heartbeat mechanism exists
- ✅ SSE broadcasts for state updates
- ✅ Client-side state object (`state.latestCurrentTrack`, etc.)
- ❌ **Heartbeat WRITES instead of READS** (actively corrupts state!)
- ❌ No server-side state machine
- ❌ Client has no "desync detected" recovery mode
- ❌ No versioning or timestamps on state updates
- ❌ Race conditions between SSE and HTTP responses

**Critical Issues**:
1. **Heartbeat corruption**: `sendNextTrack()` POSTs selection instead of checking sync (page.js:2647)
2. **Competing sources of truth**: SSE events vs HTTP response vs client state
3. **No conflict resolution**: When client and server disagree, both keep going
4. **Fallback mode invisible**: Client doesn't know server is playing noise

**Risks**:
- User hears wrong track constantly
- Selections overridden silently
- Session state drift undetectable

**Opportunity**:
Implement proper state synchronization with:
- Read-only heartbeat endpoint
- State version numbers
- Explicit sync/desync modes
- Client recovery on desync detection

**Priority**: **P1 - Critical** (causes user-facing bugs NOW)

---

### 4. ✅ **LRU Cache Pattern** (85% Complete)
**Location**: `advanced-audio-mixer.js:171-189`

**Implementation**:
- Map-based LRU cache for decoded audio buffers
- Size-based eviction (oldest-first)
- Cache hit/miss tracking
- Configurable max size

**Gaps**:
- No TTL/time-based expiration
- No memory-based eviction (only count-based)
- Cache stats not exposed via API

**Risk**: Low (working well)
**Priority**: P3

---

### 5. ⚠️ **Service Layer Pattern** (75% Complete)
**Locations**:
- `RadialSearchService` (radial-search.js)
- `MusicalKDTree` (kd-tree.js)
- `DirectionalDriftPlayer` (directional-drift-player.js)

**Strengths**:
- Clear separation of concerns
- Services are stateless (mostly)
- Single-responsibility principle followed

**Gaps**:
- Services not dependency-injected (some use singletons)
- No service lifecycle management
- No service health checks
- Services can't be hot-reloaded

**Risk**: Medium
**Priority**: P2 (refactor during growth phase)

---

### 6. 🔴 **Async Coordination Pattern** (40% Complete)
**Locations**:
- `drift-audio-mixer.js:217-320` (playCurrentTrack - just fixed!)
- `drift-audio-mixer.js:873-900` (startStreaming - just fixed!)
- Various promise chains throughout

**Current State**:
- ✅ **Just fixed**: Seeding vs seeded distinction prevents double-load
- ✅ Promises used extensively
- ❌ No promise timeout handling
- ❌ No cancellation tokens for long operations
- ❌ **Fire-and-forget async calls** without error handling
- ❌ No async operation queue/serialization
- ❌ No backpressure handling

**Risks**:
- Unhandled promise rejections crash server
- Concurrent operations still possible in other areas
- No way to cancel in-flight operations

**Critical Examples of Fire-and-Forget**:
```javascript
// page.js:852 - No await, no error handling
this.startStreaming();

// drift-audio-mixer.js:205 - Returns before async completes
this.playCurrentTrack();
```

**Opportunity**:
- Add async operation tracking
- Implement cancellation tokens
- Centralize error boundaries

**Priority**: **P1 - High** (partially fixed, but more needed)

---

### 7. ⚠️ **Error Recovery Pattern** (50% Complete)
**Locations**: Scattered throughout, notably:
- `drift-audio-mixer.js:732-802` (fallbackToNoise)
- `drift-audio-mixer.js:809-824` (handleHeartbeat retry)

**Current State**:
- ✅ Noise fallback exists
- ✅ Some retry logic (heartbeat)
- ❌ **No exponential backoff**
- ❌ **No circuit breaker pattern**
- ❌ Fallback mode not communicated to client
- ❌ No recovery attempt tracking/limits

**Risks**:
- Retry storms (heartbeat every 10s forever)
- Client unaware of degraded mode
- No automatic recovery from fallback

**Opportunity**:
Implement comprehensive error recovery:
- Exponential backoff with jitter
- Circuit breaker for repeated failures
- Client-visible degraded mode indicator
- Automatic recovery attempts

**Priority**: P1 (causes silent failures)

---

### 8. ⚠️ **Session Management Pattern** (60% Complete)
**Locations**:
- `server.js:87-104` (registration)
- `server.js:140-178` (creation)
- Express session middleware (server.js:186-200)

**Current State**:
- ✅ Express sessions with cookies
- ✅ Ephemeral vs persistent sessions
- ✅ Session cleanup callbacks
- ❌ **No session persistence** (in-memory only)
- ❌ No session timeout enforcement
- ❌ No max sessions per user
- ❌ Session state not serializable
- ❌ Can't resume sessions after server restart

**Risks**:
- Memory leak on session accumulation
- Server restart kills all sessions
- No session migration/failover

**Opportunity**:
- Implement session serialization
- Add Redis/persistent store
- Session timeout + cleanup
- Session resume capability

**Priority**: P2 (impacts scalability)

---

### 9. ❌ **Command Pattern** (15% Complete)
**Location**: Attempted in `page.js:2460-2516` (sendNextTrack)

**Current State**:
- ❌ User actions sent as raw HTTP calls
- ❌ No command queue
- ❌ No undo/redo
- ❌ No command history
- ❌ No command validation layer

**This is more of an ABSENCE than incomplete implementation**

**Opportunity**:
If building collaborative features or audit trail, implement proper command pattern

**Priority**: P4 (not needed yet)

---

## Critical Risks Summary

### 🔴 **P1 - Must Fix Now** (Causing Active Bugs)

1. **State Sync Corruption**
   - **Impact**: User selections overridden, wrong tracks play
   - **Effort**: 2-3 days
   - **Fix**: Read-only heartbeat + state versioning

2. **Event System Fragility**
   - **Impact**: Memory leaks, unreliable updates
   - **Effort**: 3-4 days
   - **Fix**: Convert to EventEmitter pattern

3. **Error Recovery Blindness**
   - **Impact**: Silent fallback to noise, no recovery
   - **Effort**: 2 days
   - **Fix**: Exponential backoff + client notification

### ⚠️ **P2 - Plan to Fix** (Technical Debt)

4. **Session Management Scalability**
   - **Impact**: Memory growth, no restart recovery
   - **Effort**: 5-7 days
   - **Fix**: Session serialization + persistence

5. **Service Layer Rigidity**
   - **Impact**: Hard to test, tight coupling
   - **Effort**: 4-5 days
   - **Fix**: Dependency injection + interfaces

### ✅ **P3 - Nice to Have**

6. **Cache Improvements**
   - **Impact**: Minor - current works well
   - **Effort**: 1-2 days

7. **Singleton Shutdown**
   - **Impact**: Minor - cleanup on restart
   - **Effort**: 1 day

---

## Implementation Plan

### Phase 1: Critical Fixes (Week 1-2)

**Goal**: Stop active user-facing bugs

#### Task 1.1: Fix Heartbeat State Sync (3 days)
**Files**: `server.js`, `page.js`

```javascript
// NEW: Read-only heartbeat endpoint
app.get('/session/heartbeat', (req, res) => {
  const session = getSessionForRequest(req);
  res.json({
    currentTrack: session.mixer.currentTrack.identifier,
    nextTrack: session.mixer.nextTrack?.identifier,
    timestamp: Date.now(),
    version: session.mixer.stateVersion, // NEW
    fallbackMode: session.mixer.isInFallback // NEW
  });
});

// Client change:
function heartbeat() {
  fetch('/session/heartbeat').then(data => {
    if (data.currentTrack !== state.currentTrack) {
      console.warn('DESYNC DETECTED');
      enterResyncMode(); // NEW
    }
  });
}
```

**Tests**:
- Heartbeat doesn't modify state
- Desync detected and triggers recovery
- State version increments on changes

---

#### Task 1.2: EventEmitter Migration (4 days)
**Files**: `drift-audio-mixer.js`, `advanced-audio-mixer.js`

**Before**:
```javascript
this.audioMixer.onTrackStart = () => { ... }
```

**After**:
```javascript
const EventEmitter = require('events');

class DriftAudioMixer extends EventEmitter {
  constructor() {
    super();
    this.audioMixer.on('trackStart', (track) => {
      this.emit('trackStart', track);
    });
  }
}

// Usage:
mixer.on('trackStart', handler1);
mixer.on('trackStart', handler2); // Multiple listeners!
mixer.removeListener('trackStart', handler1); // Proper cleanup
```

**Benefits**:
- Type-safe events
- Multiple listeners
- Automatic cleanup on `removeAllListeners()`
- Better debugging (event names visible)

**Tests**:
- Multiple listeners work
- Events delivered in order
- Cleanup doesn't leak

---

#### Task 1.3: Error Recovery Enhancement (2 days)
**Files**: `drift-audio-mixer.js`

**Add**:
```javascript
class ExponentialBackoff {
  constructor(baseDelay = 1000, maxDelay = 60000) {
    this.baseDelay = baseDelay;
    this.maxDelay = maxDelay;
    this.attempts = 0;
  }

  next() {
    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.attempts),
      this.maxDelay
    );
    this.attempts++;
    return delay + Math.random() * 1000; // Jitter
  }

  reset() { this.attempts = 0; }
}

// In DriftAudioMixer:
this.fallbackBackoff = new ExponentialBackoff();

async fallbackToNoise() {
  this.isInFallback = true; // NEW FLAG
  this.emit('fallback', { reason: 'track_load_failed' }); // NOTIFY

  // Try recovery after backoff
  const retryDelay = this.fallbackBackoff.next();
  setTimeout(() => this.attemptRecovery(), retryDelay);
}

// Client gets notified via SSE
if (data.fallbackMode) {
  showWarningBanner('Audio temporarily unavailable, retrying...');
}
```

**Tests**:
- Backoff increases exponentially
- Max delay respected
- Client notified of fallback
- Recovery attempted

---

### Phase 2: Infrastructure Improvements (Week 3-4)

#### Task 2.1: Session Serialization (5 days)
**Goal**: Survive server restarts

```javascript
class DriftAudioMixer {
  serialize() {
    return {
      sessionId: this.sessionId,
      currentTrack: this.currentTrack,
      sessionHistory: this.sessionHistory,
      explorerResolution: this.explorerResolution,
      seenArtists: Array.from(this.seenArtists),
      // ... serializable state
    };
  }

  static deserialize(data, radialSearch) {
    const mixer = new DriftAudioMixer(data.sessionId, radialSearch);
    mixer.currentTrack = data.currentTrack;
    mixer.sessionHistory = data.sessionHistory;
    // ... restore state
    return mixer;
  }
}

// On server shutdown:
process.on('SIGTERM', async () => {
  const sessions = Array.from(audioSessions.values())
    .map(s => s.mixer.serialize());
  await fs.writeFile('sessions.json', JSON.stringify(sessions));
});

// On startup:
const savedSessions = JSON.parse(fs.readFileSync('sessions.json'));
savedSessions.forEach(data => {
  const mixer = DriftAudioMixer.deserialize(data, radialSearch);
  // ...
});
```

---

#### Task 2.2: Dependency Injection (4 days)
**Goal**: Testability and loose coupling

```javascript
// Before:
class DriftAudioMixer {
  constructor(sessionId, radialSearch) {
    this.audioMixer = new AdvancedAudioMixer(); // TIGHT COUPLING
  }
}

// After:
class DriftAudioMixer {
  constructor(sessionId, dependencies) {
    this.radialSearch = dependencies.radialSearch;
    this.audioMixer = dependencies.audioMixer; // INJECTED
    this.config = dependencies.config;
  }
}

// In server.js:
const dependencies = {
  radialSearch,
  audioMixer: new AdvancedAudioMixer(config.audio),
  config
};
const mixer = new DriftAudioMixer(sessionId, dependencies);

// Testing becomes trivial:
const mockMixer = { loadTrack: jest.fn() };
const testMixer = new DriftAudioMixer('test', { audioMixer: mockMixer });
```

---

### Phase 3: Polish (Week 5+)

- Cache memory limits
- Graceful shutdown coordination
- Session timeout enforcement
- Command pattern for undo/redo

---

## Low-Hanging Fruit (Quick Wins)

### 1. **Add State Version to Fix Race Conditions** (2 hours)
```javascript
// drift-audio-mixer.js
constructor() {
  this.stateVersion = 0;
}

setCurrentTrack(track) {
  this.currentTrack = track;
  this.stateVersion++;
  this.emit('stateChange', { version: this.stateVersion });
}
```

### 2. **Add `isInFallback` Flag** (1 hour)
```javascript
fallbackToNoise() {
  this.isInFallback = true;
  this.broadcastTrackEvent(); // Include flag in SSE
}
```

### 3. **Client Desync Warning** (2 hours)
```javascript
// page.js
if (serverTrack !== clientTrack && !resyncInProgress) {
  showWarning('🔄 Resyncing with server...');
  fullResync();
}
```

### 4. **Add Event Names Constants** (1 hour)
```javascript
// events.js
const EVENTS = {
  TRACK_START: 'trackStart',
  TRACK_END: 'trackEnd',
  CROSSFADE_START: 'crossfadeStart',
  ERROR: 'error'
};

mixer.emit(EVENTS.TRACK_START, track); // Typo-proof!
```

---

## Metrics to Track

### Before Improvements:
- [ ] Count heartbeat-triggered track changes per hour
- [ ] Measure desync frequency (client vs server mismatch)
- [ ] Track fallback duration (time in noise mode)
- [ ] Count unhandled promise rejections

### After Improvements:
- [ ] Heartbeat changes = 0 (read-only)
- [ ] Desync detection + recovery time < 5s
- [ ] Fallback with exponential backoff + client notification
- [ ] Zero unhandled rejections

---

## Conclusion

**9 patterns identified, 3 critically incomplete:**

1. ✅ **Quick wins available**: State versioning, fallback flag, desync warning (5 hours total)
2. 🔴 **Critical path**: Fix state sync → Fix events → Fix error recovery (9 days)
3. ⚠️ **Medium term**: Session persistence → DI pattern (9 days)

**Biggest risk**: State synchronization corruption causing user-visible bugs
**Biggest opportunity**: EventEmitter conversion enables reliable real-time features

**Recommended start**: Phase 1, Task 1.1 (Heartbeat fix) - stops active corruption immediately.
