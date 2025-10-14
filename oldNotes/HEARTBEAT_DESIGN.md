# Heartbeat & Sync Design

## Overview
Unified flow for all next-track communications, with automatic heartbeat to prevent zombie sessions.

## State Tracking
```javascript
let lastNextTrackMd5 = null;        // Last MD5 we sent to server
let lastNextTrackDirection = null;  // Last direction we sent
let heartbeatTimeout = null;        // Timer for 60s heartbeat
let currentTrackMd5 = null;         // Current playing track (from SSE)
let expectedRemaining = null;       // Expected time remaining
```

## Unified Flow

```javascript
// Single function handles all three cases
async function sendNextTrack(trackMd5 = null, direction = null, source = 'user') {
  // source: 'user' | 'heartbeat' | 'manual_refresh'

  // Clear existing heartbeat
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }

  // Use last values if not provided (heartbeat/refresh case)
  const md5ToSend = trackMd5 || lastNextTrackMd5;
  const dirToSend = direction || lastNextTrackDirection;

  if (!md5ToSend) {
    console.warn('⚠️ No track MD5 to send, skipping');
    return;
  }

  console.log(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend}`);

  try {
    const response = await fetch('/next-track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trackMd5: md5ToSend,
        direction: dirToSend
      })
    });

    if (!response.ok) throw new Error('Network error');

    const data = await response.json();
    // data = { nextTrack, currentTrack, duration, remaining }

    // Save for future heartbeats
    lastNextTrackMd5 = data.nextTrack;
    lastNextTrackDirection = dirToSend;

    // Analyze response and take action
    analyzeAndAct(data, source);

  } catch (error) {
    console.error('❌ sendNextTrack failed:', error);
    // Set shorter retry timeout
    scheduleHeartbeat(10000); // Retry in 10s
  }
}

function analyzeAndAct(data, source) {
  const { nextTrack, currentTrack, duration, remaining } = data;

  console.log(`📊 Server state: current=${currentTrack?.substring(0,8)}, remaining=${remaining}ms`);

  // Check if current track matches what we think is playing
  const trackChanged = currentTrackMd5 && currentTrack !== currentTrackMd5;

  // Check if timing is way off (>5 seconds difference)
  const timingOff = expectedRemaining && Math.abs(remaining - expectedRemaining) > 5000;

  if (trackChanged) {
    console.log(`🔄 Track changed! Was ${currentTrackMd5?.substring(0,8)}, now ${currentTrack?.substring(0,8)}`);
    fullResync();
  } else if (timingOff) {
    console.log(`⏰ Timing drift detected! Expected ${expectedRemaining}ms, got ${remaining}ms`);
    fullResync();
  } else {
    // All good - just update our state
    console.log(`✅ Sync confirmed (${source})`);
    currentTrackMd5 = currentTrack;
    expectedRemaining = remaining;

    // Update progress bar if needed
    if (duration && remaining) {
      updateProgressBar(duration, remaining);
    }

    // Schedule next heartbeat (60s from now)
    scheduleHeartbeat(60000);
  }
}

function scheduleHeartbeat(delayMs = 60000) {
  if (heartbeatTimeout) {
    clearTimeout(heartbeatTimeout);
  }

  heartbeatTimeout = setTimeout(() => {
    console.log('💓 Heartbeat triggered');
    sendNextTrack(null, null, 'heartbeat');
  }, delayMs);

  console.log(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

async function fullResync() {
  console.log('🔄 Full resync triggered - calling /refresh-sse');

  try {
    const response = await fetch('/refresh-sse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    const result = await response.json();

    if (result.ok) {
      console.log('✅ Resync broadcast triggered, waiting for SSE update...');
      // SSE event will update UI
    } else {
      console.warn('⚠️ Resync failed:', result.reason);
    }
  } catch (error) {
    console.error('❌ Resync error:', error);
  }
}

function updateProgressBar(durationMs, remainingMs) {
  const elapsed = durationMs - remainingMs;
  const progress = (elapsed / durationMs) * 100;

  if (progressWipe) {
    progressWipe.style.width = `${progress}%`;
  }

  // Update expected remaining for next check
  expectedRemaining = remainingMs;
}
```

## Integration Points

### User Selection
```javascript
// When user clicks a track card
card.addEventListener('click', () => {
  sendNextTrack(track.identifier, direction.key, 'user');
});
```

### Manual Refresh Button
```javascript
refreshButton.addEventListener('click', () => {
  sendNextTrack(null, null, 'manual_refresh');
});
```

### SSE Track Event
```javascript
// When new track starts via SSE
if (event.type === 'track') {
  currentTrackMd5 = event.data.track.identifier;
  expectedRemaining = event.data.track.duration * 1000;
  // Don't trigger heartbeat here - let it run on schedule
}
```

## Benefits

1. **No more zombies** - 60s heartbeat ensures we detect stuck sessions
2. **Lazy sync** - Only full resync when actually needed
3. **Single code path** - All next-track logic unified
4. **Timing awareness** - Track expected state for drift detection
5. **Graceful degradation** - Shorter retry on errors

## Migration Path

1. Add state variables
2. Implement `sendNextTrack()` and `analyzeAndAct()`
3. Replace all existing `fetch('/next-track')` calls with `sendNextTrack()`
4. Update SSE handler to track `currentTrackMd5`
5. Wire up refresh button
6. Test zombie recovery