// Session Object Definitions - Separating Core Audio State from Runtime Management
// Pure type definitions for shared lexicon - no validation, just clarity

const { z } = require('zod');
const { AnyTrack } = require('./track-definitions');
const { ExplorerDirections } = require('./direction-definitions');

// ==================== SESSION CORE DATA (STABLE) ====================

// Core session identity and configuration - doesn't change during operation
const SessionDataCore = z.object({
  // Identity
  sessionId: z.string(),                    // Unique session identifier
  isEphemeral: z.boolean().default(false),  // Whether session auto-cleans up
  
  // Creation metadata
  created: z.date(),                        // Session creation time
  creatorIp: z.string().optional(),         // IP that created session
  fingerprint: z.string().optional(),       // Unique fingerprint for session
  
  // Audio configuration
  audioConfig: z.object({
    sampleRate: z.number().default(44100),  // Audio sample rate
    channels: z.number().default(2),        // Number of channels
    bitRate: z.number().default(192),       // Bitrate for streaming
  }).optional(),
  
  // Exploration settings
  explorerConfig: z.object({
    resolution: z.enum(['microscope', 'magnifying_glass', 'binoculars']).default('magnifying_glass'),
    maxHistorySize: z.number().default(50), // Maximum history entries
    enableBidirectional: z.boolean().default(true), // Enable opposite directions
  }).optional(),
});

// ==================== AUDIO STATE (CORE PLAYBACK) ====================

// Current audio playback state - the musical "now"
const AudioPlaybackState = z.object({
  // Current track information
  currentTrack: AnyTrack.optional(),        // Currently playing track
  pendingCurrentTrack: AnyTrack.optional(), // Track being prepared
  nextTrack: AnyTrack.optional(),           // Track prepared for crossfade
  
  // Timing information
  trackStartTime: z.number().optional(),    // When current track started (timestamp)
  trackPosition: z.number().optional(),     // Current position in track (seconds)
  
  // Playback state
  isActive: z.boolean().default(false),     // Whether audio is streaming
  isTransitioning: z.boolean().default(false), // Whether in crossfade
  
  // User overrides
  lockedNextTrackIdentifier: z.string().optional(), // User-selected next track
  pendingUserOverrideTrackId: z.string().optional(), // Override being prepared
  pendingUserOverrideDirection: z.string().optional(), // Direction for override
  isUserSelectionPending: z.boolean().default(false), // User selection in progress
  userSelectionDeferredForCrossfade: z.boolean().default(false), // Selection delayed
});

// ==================== SESSION HISTORY (EXPLORATION MEMORY) ====================

// Musical exploration history and learning
const SessionHistory = z.object({
  // Track history
  sessionHistory: z.array(z.object({
    track: AnyTrack,
    timestamp: z.date(),
    direction: z.string().optional(),       // How we got to this track
    userSelected: z.boolean().default(false), // Whether user chose this track
  })).default([]),
  
  // Exposure tracking for diversity
  seenTracks: z.set(z.string()).default(new Set()), // Track identifiers we've played
  seenArtists: z.set(z.string()).default(new Set()), // Artists we've encountered  
  seenAlbums: z.set(z.string()).default(new Set()), // Albums we've heard
  seenTrackArtists: z.set(z.string()).default(new Set()), // Track-artist pairs
  seenTrackAlbums: z.set(z.string()).default(new Set()), // Track-album pairs
});

// ==================== SESSION RUNTIME STATE (MUTABLE) ====================

// Runtime state that changes constantly during operation
const SessionRuntimeState = z.object({
  // Connection tracking
  clients: z.set(z.any()).default(new Set()), // Connected audio streaming clients
  eventClients: z.set(z.any()).default(new Set()), // Connected SSE clients
  lastAccess: z.date(),                     // Last time session was accessed
  lastActivity: z.date().optional(),        // Last meaningful activity
  
  // Client metadata
  clientConnections: z.array(z.object({
    clientId: z.string().optional(),
    clientIp: z.string().optional(),
    connectionTime: z.date(),
    lastSeen: z.date(),
    connectionType: z.enum(['audio', 'events', 'metadata']),
  })).default([]),
  
  // Process management
  currentProcess: z.any().optional(),       // FFmpeg/external process handle
  processId: z.number().optional(),         // System process ID
  
  // Health and monitoring
  isHealthy: z.boolean().default(true),     // Overall session health
  awaitingAudioClient: z.boolean().default(false), // Waiting for audio connection
  pendingClientBootstrap: z.boolean().default(false), // Client bootstrap pending
  
  // Performance caching
  lastHeartbeatPayload: z.any().optional(), // Cached heartbeat data
  lastHeartbeatSerialized: z.string().optional(), // Serialized version
  lastExplorerSnapshotPayload: z.any().optional(), // Cached explorer data
  lastExplorerSnapshotSerialized: z.string().optional(), // Serialized version
});

// ==================== EXPLORER STATE CACHE ====================

// Cached exploration data and search results
const ExplorerStateCache = z.object({
  // Explorer data cache (by track+resolution key)
  explorerDataCache: z.map(z.string(), ExplorerDirections).default(new Map()),
  
  // Current explorer state
  latestExplorerData: ExplorerDirections.optional(), // Most recent explorer data
  explorerResolution: z.enum(['adaptive', 'microscope', 'magnifying_glass', 'binoculars']).default('adaptive'),
  
  // Loading state
  currentTrackLoadingPromise: z.any().optional(), // Prevents concurrent loads
  explorerDataGenerationInProgress: z.boolean().default(false),
});

// ==================== COMPLETE SESSION TYPES ====================

// Regular persistent session
const PersistentSession = z.object({
  // Core data (stable)
  data: SessionDataCore.extend({
    isEphemeral: z.literal(false),
  }),
  
  // Audio state (musical core)
  audioState: AudioPlaybackState,
  
  // History (exploration memory)
  history: SessionHistory,
  
  // Runtime state (connections, processes)
  runtime: SessionRuntimeState,
  
  // Explorer cache (search results)
  explorerCache: ExplorerStateCache,
});

// Ephemeral one-off session (for direct track access)
const EphemeralSession = z.object({
  // Core data (minimal for ephemeral)
  data: SessionDataCore.extend({
    isEphemeral: z.literal(true),
    targetTrackMd5: z.string(),             // Required: track this session will play
    expiresAt: z.date(),                    // Required: when session expires
  }),
  
  // Minimal state for ephemeral sessions
  audioState: AudioPlaybackState,
  runtime: SessionRuntimeState.pick({
    clients: true,
    eventClients: true,
    lastAccess: true,
    isHealthy: true,
    currentProcess: true,
  }),
});

// ==================== SESSION WRAPPER ====================

// The lightweight wrapper that server.js uses
const SessionWrapper = z.object({
  sessionId: z.string(),                    // Session identifier
  mixer: z.any(),                           // DriftAudioMixer instance (contains the real state)
  created: z.date(),                        // Creation timestamp  
  lastAccess: z.date(),                     // Last access timestamp
  isEphemeral: z.boolean(),                 // Cleanup flag
  
  // Runtime connection metadata (added by server)
  clientIp: z.string().optional(),
  lastAudioConnect: z.number().optional(),
  awaitingAudioClient: z.boolean().optional(),
  lastAudioClientAt: z.number().optional(),
  lastMetadataConnect: z.number().optional(),
  lastMetadataIp: z.string().optional(),
});

// ==================== SESSION COLLECTIONS ====================

// Session management state
const SessionManager = z.object({
  // Session storage
  audioSessions: z.map(z.string(), SessionWrapper), // Persistent sessions
  ephemeralSessions: z.map(z.string(), SessionWrapper), // Temporary sessions
  lastHealthySessionByIp: z.map(z.string(), z.string()), // IP -> sessionId mapping
  
  // Configuration
  sessionTimeout: z.number().default(3600000), // 1 hour in milliseconds
  maxSessionsPerIp: z.number().default(5),     // Max concurrent sessions per IP
  cleanupInterval: z.number().default(300000), // 5 minutes in milliseconds
});

// ==================== SESSION UTILITIES ====================

const SessionUtilities = {
  // Check if session is healthy
  isSessionHealthy: (session) => {
    const now = Date.now();
    const lastAccess = session.lastAccess?.getTime() || 0;
    const isRecent = (now - lastAccess) < 3600000; // 1 hour
    const hasClients = session.mixer?.clients?.size > 0 || false;
    return isRecent && hasClients;
  },
  
  // Get current track from any session type
  getCurrentTrack: (session) => {
    if (session.mixer?.currentTrack) return session.mixer.currentTrack;
    if (session.audioState?.currentTrack) return session.audioState.currentTrack;
    return null;
  },
  
  // Check if session is ephemeral
  isEphemeral: (session) => {
    return session.isEphemeral === true || session.data?.isEphemeral === true;
  },
  
  // Get session age in milliseconds
  getSessionAge: (session) => {
    const created = session.created || session.data?.created;
    return created ? Date.now() - created.getTime() : 0;
  },
  
  // Extract session ID from various sources
  getSessionId: (session) => {
    return session.sessionId || session.data?.sessionId || session.mixer?.sessionId;
  },
  
  // Check if session should be cleaned up
  shouldCleanup: (session, timeoutMs = 3600000) => {
    if (SessionUtilities.isEphemeral(session)) {
      // Ephemeral sessions clean up when no clients
      const hasClients = session.mixer?.clients?.size > 0 || session.runtime?.clients?.size > 0;
      return !hasClients;
    }
    
    // Regular sessions clean up after timeout
    const age = SessionUtilities.getSessionAge(session);
    const lastAccess = session.lastAccess?.getTime() || 0;
    const timeSinceAccess = Date.now() - lastAccess;
    return timeSinceAccess > timeoutMs;
  }
};

module.exports = {
  // Core data schemas
  SessionDataCore,
  AudioPlaybackState,
  SessionHistory,
  SessionRuntimeState,
  ExplorerStateCache,
  
  // Complete session types
  PersistentSession,
  EphemeralSession,
  SessionWrapper,
  
  // Management schemas
  SessionManager,
  
  // Utilities
  SessionUtilities,
};
