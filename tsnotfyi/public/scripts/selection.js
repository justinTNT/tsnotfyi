// Selection state — unified track selection with source-aware protection
// Replaces: state.selectedIdentifier, state.manualNextTrackOverride,
//           state.manualNextDirectionKey, state.pendingManualTrackId

import { state } from './globals.js';

const TRACK_CHANGE_GRACE_MS = 1500; // protect selections made during crossfade transition

export function setSelection(trackId, source, directionKey = null) {
  const isUser = source === 'user' || source === 'ack';
  // Server sources cannot overwrite user selections
  if (!isUser && state.selection.source === 'user') return state.selection;
  state.selection = {
    trackId,
    directionKey: directionKey || (isUser ? null : state.selection.directionKey),
    pendingTrackId: isUser ? trackId : state.selection.pendingTrackId,
    source,
    generation: source === 'user' ? state.selection.generation + 1 : state.selection.generation,
    setAt: Date.now(),
  };
  return state.selection;
}

export function clearSelection(reason) {
  // User selections survive everything except track_change and explicit clears
  if (state.selection.source === 'user') {
    const alwaysClear = reason === 'track_change' || reason === 'selection_failed'
      || reason === 'error' || reason === 'no_track' || reason === 'init'
      || reason === 'audio_restart';
    if (!alwaysClear) return false;
    // Grace period: if user selected during crossfade, don't clobber their fresh choice
    if (reason === 'track_change' && state.selection.setAt
        && (Date.now() - state.selection.setAt) < TRACK_CHANGE_GRACE_MS) {
      return false;
    }
  }
  state.selection = {
    trackId: null,
    directionKey: null,
    pendingTrackId: null,
    source: null,
    generation: state.selection.generation,
    setAt: null,
  };
  return true;
}

export function isUserSelection() {
  return state.selection.source === 'user' || state.selection.source === 'ack';
}
