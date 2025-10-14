# Multi-Session Architecture Roadmap

## Current State (Single Master Session)

The server currently operates with a **single master session** that all clients connect to:
- One `DriftAudioMixer` instance serves all clients
- Preloaded session for instant startup
- All clients hear the same audio stream
- SSE events broadcast to all connected clients

## Why We Need Multi-Session

### Use Cases
1. **Named Sessions** - Multiple people exploring different musical journeys simultaneously
   - `/session/jazz-exploration` - Friend 1's journey
   - `/session/ambient-deep-dive` - Friend 2's journey
   - Each with independent audio streams and exploration state

2. **Follower Sessions** - Spectator mode for collaborative listening
   - One person drives exploration
   - Others follow along (receive events but can't send commands)
   - Think: Twitch for music exploration

3. **Party Mode with Multiple Rooms**
   - Kitchen stream playing upbeat tracks
   - Living room playing ambient
   - Each room independently controllable

## Architecture Design

### Session Types

```javascript
{
  master: {
    // Current implementation - default session
    sessionId: 'master_abc123',
    type: 'master',
    allowCommands: true,
    mixer: DriftAudioMixer,
    clients: Set<Response>,
    eventClients: Set<Response>
  },

  named: {
    // User-created named session
    sessionId: 'my-session-name',
    type: 'named',
    allowCommands: true,
    mixer: DriftAudioMixer,
    clients: Set<Response>,
    eventClients: Set<Response>,
    created: Date
  },

  follower: {
    // Read-only session following another
    sessionId: 'follower_xyz789',
    type: 'follower',
    followingSession: 'my-session-name',
    allowCommands: false,
    mixer: null, // Followers don't create audio, they observe
    eventClients: Set<Response>
  }
}
```

### API Endpoints to Implement

#### Session Management
```
POST /api/session/create
  Body: { sessionName, options?: { startingTrack, direction } }
  Returns: { sessionId, type, webUrl, streamUrl, eventsUrl }

POST /api/session/follow
  Body: { sessionName, followerName? }
  Returns: { sessionId, type, followingSession, webUrl, eventsUrl }

GET /api/session/list
  Returns: { sessions: [{ sessionId, type, clients, created }] }

DELETE /api/session/:sessionId
  Destroys session and disconnects clients
```

#### Session Endpoints (to restore)
```
GET /session/create/:sessionName
  Creates named session and redirects to session page

GET /session/follow/:sessionName
  Creates follower session and redirects to session page

GET /session/:sessionId
  Serves session page (already exists, needs session type awareness)
```

### Key Implementation Details

#### 1. Session Storage
```javascript
// Replace simple Map with structured storage
const sessions = new Map(); // sessionId -> Session object

class Session {
  constructor(sessionId, type, options = {}) {
    this.sessionId = sessionId;
    this.type = type; // 'master' | 'named' | 'follower'
    this.created = new Date();
    this.lastAccess = new Date();

    if (type === 'follower') {
      this.followingSession = options.followingSession;
      this.allowCommands = false;
      this.mixer = null;
      this.eventClients = new Set();
    } else {
      this.allowCommands = true;
      this.mixer = new DriftAudioMixer(sessionId, radialSearch);
      this.clients = new Set();
      this.eventClients = new Set();
    }
  }
}
```

#### 2. Stream Routing
```javascript
app.get('/stream/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.type === 'follower') {
    // Redirect to the session they're following
    const targetSession = sessions.get(session.followingSession);
    if (!targetSession) {
      return res.status(404).json({ error: 'Target session not found' });
    }
    targetSession.mixer.addClient(res);
  } else {
    session.mixer.addClient(res);
  }
});
```

#### 3. Event Broadcasting
```javascript
app.get('/events/:sessionId', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Set up SSE
  res.writeHead(200, { 'Content-Type': 'text/event-stream', ... });

  if (session.type === 'follower') {
    // Subscribe to events from the followed session
    const targetSession = sessions.get(session.followingSession);
    targetSession.eventClients.add(res);
  } else {
    session.eventClients.add(res);
  }
});
```

#### 4. Command Authorization
```javascript
app.post('/session/:sessionId/next-track', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.allowCommands) {
    return res.status(403).json({
      error: 'Follower sessions cannot send commands',
      followingSession: session.followingSession
    });
  }

  // Process command...
});
```

#### 5. Session Cleanup
```javascript
// Enhanced cleanup with session type awareness
setInterval(() => {
  const now = new Date();
  const timeout = 30 * 60 * 1000; // 30 minutes

  for (const [sessionId, session] of sessions) {
    const hasClients = (session.clients?.size || 0) + (session.eventClients?.size || 0) > 0;
    const isActive = session.mixer?.isActive;
    const isStale = now - session.lastAccess > timeout;

    // Don't clean up master session
    if (session.type === 'master') continue;

    if (!hasClients && !isActive && isStale) {
      console.log(`Cleaning up ${session.type} session: ${sessionId}`);
      session.mixer?.destroy();
      sessions.delete(sessionId);
    }
  }
}, 60 * 1000);
```

## Frontend Changes Needed

### Session Awareness
```javascript
// Detect session type from URL or API
const sessionInfo = await fetch('/api/session/info').then(r => r.json());

if (sessionInfo.type === 'follower') {
  // Disable UI controls
  disableExplorationControls();
  showFollowerBadge();
  // Still show visualizations and track info
}
```

### UI Indicators
- Badge showing session type: `[FOLLOWING: jazz-exploration]`
- Disable buttons/controls for followers
- Show "Session is read-only" message

## Migration Strategy

### Phase 1: Session Class & Storage (1-2 hours)
- Create `Session` class
- Migrate master session to new structure
- Keep backward compatibility

### Phase 2: Named Sessions (2-3 hours)
- Implement `/api/session/create`
- Test multiple independent sessions
- Verify stream isolation

### Phase 3: Follower Sessions (1-2 hours)
- Implement `/api/session/follow`
- Add command authorization
- Test event relay

### Phase 4: Frontend Updates (2-3 hours)
- Session type detection
- UI state management
- Control disabling for followers

### Phase 5: Testing & Polish (1-2 hours)
- Multi-session stress test
- Edge case handling
- Documentation

**Total Estimated Time: 7-12 hours**

## Testing Checklist

- [ ] Create named session, verify independent audio stream
- [ ] Create multiple named sessions simultaneously
- [ ] Create follower session, verify read-only behavior
- [ ] Follower receives events from followed session
- [ ] Follower cannot send commands (authorization check)
- [ ] Session cleanup works correctly
- [ ] Master session still works as before
- [ ] Client disconnect handling for all session types
- [ ] Session list API returns correct data
- [ ] Long-running sessions don't leak memory

## Removed Code Reference

The incomplete multi-session scaffolding was removed from `server.js`:
- Lines 146-239: Named/follower API endpoints (incomplete TODOs)
- Lines 345-433: Named session creation endpoints (incomplete)

This document serves as the blueprint for proper reintroduction.

**Note:** Simple private multi-session implementation - no authentication, discovery, or complex persistence needed.