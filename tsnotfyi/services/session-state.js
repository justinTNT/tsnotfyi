// SessionState — serializable session identity, journey, history, and config
// Extracted from DriftAudioMixer constructor + getStackState/loadStackState
// The mixer holds this.state = new SessionState() and references this.state.* explicitly

class SessionState {
  constructor(opts = {}) {
    // Identity
    this.sessionId = opts.sessionId || null;
    this.sessionType = opts.sessionType || 'anonymous';
    this.sessionName = opts.sessionName || null;
    this.ephemeral = opts.ephemeral || false;
    this.created = opts.created || new Date().toISOString();

    // Journey
    this.stack = opts.stack || [];
    this.stackIndex = opts.stackIndex || 0;
    this.positionSeconds = opts.positionSeconds || 0;

    // History / negative state
    this.sessionHistory = opts.sessionHistory || [];
    this.seenArtists = new Set(opts.seenArtists || []);
    this.seenAlbums = new Set(opts.seenAlbums || []);
    this.seenTracks = new Set(opts.seenTracks || []);
    this.seenTrackArtists = new Set(opts.seenTrackArtists || []);
    this.seenTrackAlbums = new Set(opts.seenTrackAlbums || []);
    this.failedTrackAttempts = new Map(opts.failedTrackAttempts || []);
    this.maxHistorySize = opts.maxHistorySize || 50;

    // Filtering config
    this.noArtist = opts.noArtist ?? true;
    this.noAlbum = opts.noAlbum ?? true;

    // Explorer config
    this.stackTotalCount = opts.stackTotalCount || 15;
    this.stackRandomCount = opts.stackRandomCount ?? 3;
    this.explorerResolution = opts.explorerResolution || 'adaptive';

    // Current position
    this.currentTrack = opts.currentTrack || null;
    this.currentTrackDirection = opts.currentTrackDirection || null;
    this.trackStartTime = opts.trackStartTime || null;
  }

  serialize() {
    return {
      // Journey
      sessionType: this.sessionType,
      sessionName: this.sessionName,
      stack: [...this.stack],
      stackIndex: this.stackIndex,
      positionSeconds: this.positionSeconds,
      ephemeral: this.ephemeral,

      // Negative state
      seenArtists: [...this.seenArtists],
      seenAlbums: [...this.seenAlbums],
      seenTracks: [...this.seenTracks],
      seenTrackArtists: [...this.seenTrackArtists],
      seenTrackAlbums: [...this.seenTrackAlbums],
      sessionHistory: (this.sessionHistory || []).map(h => ({
        identifier: h.identifier,
        title: h.title,
        artist: h.artist,
        direction: h.direction,
        timestamp: h.timestamp || h.startTime
      })),
      failedTrackAttempts: [...this.failedTrackAttempts],

      // Config
      noArtist: this.noArtist,
      noAlbum: this.noAlbum,
      stackTotalCount: this.stackTotalCount,
      stackRandomCount: this.stackRandomCount,

      // Current track pointer
      currentTrackId: this.currentTrack?.identifier || null,
      currentTrackDirection: this.currentTrackDirection || null,

      // Metadata
      created: this.created || new Date().toISOString(),
      lastAccess: new Date().toISOString()
    };
  }

  static fromSerialized(data) {
    return new SessionState({
      sessionType: data.sessionType,
      sessionName: data.sessionName,
      stack: data.stack,
      stackIndex: data.stackIndex,
      positionSeconds: data.positionSeconds,
      ephemeral: data.ephemeral,
      created: data.created,
      seenArtists: data.seenArtists,
      seenAlbums: data.seenAlbums,
      seenTracks: data.seenTracks,
      seenTrackArtists: data.seenTrackArtists,
      seenTrackAlbums: data.seenTrackAlbums,
      sessionHistory: data.sessionHistory,
      failedTrackAttempts: data.failedTrackAttempts,
      noArtist: data.noArtist,
      noAlbum: data.noAlbum,
      stackTotalCount: data.stackTotalCount,
      stackRandomCount: data.stackRandomCount,
      currentTrackDirection: data.currentTrackDirection,
      explorerResolution: data.explorerResolution
    });
  }
}

module.exports = SessionState;
