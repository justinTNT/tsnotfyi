// TSNotFYI Schema Definitions - Master Index
// Pure type definitions for shared lexicon between human and AI agents
// No validation, no runtime integration - just structural clarity

// ==================== IMPORT ALL DEFINITIONS ====================

const TrackSchemas = require('./track-definitions');
const DirectionSchemas = require('./direction-definitions');
const CardSchemas = require('./card-definitions');
const SessionSchemas = require('./session-definitions');
const ExplorerSchemas = require('./explorer-definitions');

// ==================== MASTER LEXICON ====================

/**
 * TSNotFYI Domain Model - Shared Vocabulary for Agent Communication
 * 
 * This lexicon defines the complex data structures in the TSNotFYI music exploration system.
 * The goal is to enable precise, high-bandwidth communication between human and AI agents
 * by establishing clear definitions of polymorphic and nested structures.
 * 
 * CORE VOCABULARY:
 * - Dimension: A measurable musical property (tempo, brightness) - an index into feature space
 * - Direction: The relationship between two tracks on a specific dimension (increase/decrease)
 * - Stack: The curated track selection representing that directional relationship
 * 
 * PHILOSOPHY:
 * - Pure definitions, no validation ceremony
 * - Separation of data vs UI state vs runtime state
 * - Union types for polymorphic structures
 * - Utility functions that mirror actual codebase logic
 * - Shared understanding over type safety
 */

const TSNotFYISchemas = {
  
  // ==================== TRACK OBJECTS ====================
  // The polymorphic nightmare - one concept, many shapes
  Track: {
    // Core building blocks
    Core: TrackSchemas.TrackIdentifierCore,      // The 5 ways to identify a track
    Metadata: TrackSchemas.TrackMetadataCore,    // Basic track information
    Features: TrackSchemas.AudioFeatures,        // 21 musical analysis features
    PCA: TrackSchemas.PCACoordinates,           // Principal component analysis values
    MetadataLocations: TrackSchemas.MetadataLocations, // 6+ places metadata can live
    
    // Context-specific variants
    Database: TrackSchemas.DatabaseTrack,        // From PostgreSQL via KD-tree
    SearchResult: TrackSchemas.SearchResultTrack, // From fuzzy search API
    Explorer: TrackSchemas.ExplorerTrack,        // In direction.sampleTracks with distance
    Client: TrackSchemas.ClientTrack,           // Client-side with UI state
    Wrapped: TrackSchemas.WrappedTrack,         // The dreaded { track: actualTrack }
    
    // Union type for any track variation
    Any: TrackSchemas.AnyTrack,
    
    // Resolution utilities
    getIdentifier: TrackSchemas.getTrackIdentifier,
    unwrap: TrackSchemas.unwrapTrack,
    getTitle: TrackSchemas.getTrackTitle,
  },
  
  // ==================== DIRECTION OBJECTS ====================
  // Musical exploration: directions along dimensions with track stacks
  Direction: {
    // Core enums
    DimensionDomain: DirectionSchemas.DimensionDomain,    // tonal/spectral/rhythmic/original
    DimensionComponent: DirectionSchemas.DimensionComponent, // pc1/pc2/pc3/feature
    Polarity: DirectionSchemas.DirectionPolarity, // positive/negative
    Type: DirectionSchemas.DirectionType,        // For UI styling classification
    KeyPattern: DirectionSchemas.DirectionKeyPattern, // Regex patterns for direction keys
    
    // Direction structures
    Core: DirectionSchemas.DirectionCore,        // Direction with track stack
    Bidirectional: DirectionSchemas.BidirectionalDirection, // With embedded opposite
    Complete: DirectionSchemas.Direction,        // Full direction object
    Map: DirectionSchemas.DirectionMap,          // Record<string, Direction>
    ExplorerSet: DirectionSchemas.ExplorerDirections, // Complete explorer response
    
    // Direction utilities
    Utils: DirectionSchemas.DirectionKeyUtilities,
  },
  
  // ==================== CARD OBJECTS ====================
  // UI representations with dual nature: data + state separation
  Card: {
    // Data vs State separation
    Data: CardSchemas.CardDataCore,             // Immutable card identity
    UIState: CardSchemas.CardUIState,           // Mutable interaction state
    
    // Complete card types  
    Track: CardSchemas.TrackCard,               // Track detail cards
    Direction: CardSchemas.DirectionCard,       // Direction cards with stacks
    
    // Relationship modeling
    DirectionRelation: CardSchemas.CardDirectionRelation,
    TrackRelation: CardSchemas.CardTrackRelation,
    Collection: CardSchemas.CardCollection,     // Complete card manager state
    
    // Card utilities
    Utils: CardSchemas.CardUtilities,
  },
  
  // ==================== SESSION OBJECTS ====================
  // Multi-layered audio session management
  Session: {
    // State layer separation
    Data: SessionSchemas.SessionDataCore,       // Stable configuration
    AudioState: SessionSchemas.AudioPlaybackState, // Musical "now"
    History: SessionSchemas.SessionHistory,     // Exploration memory
    Runtime: SessionSchemas.SessionRuntimeState, // Connections, processes
    Cache: SessionSchemas.ExplorerStateCache,   // Performance optimization
    
    // Complete session types
    Persistent: SessionSchemas.PersistentSession, // Regular sessions
    Ephemeral: SessionSchemas.EphemeralSession, // One-off track access
    Wrapper: SessionSchemas.SessionWrapper,     // Server.js lightweight wrapper
    
    // Session management
    Manager: SessionSchemas.SessionManager,     // Global session state
    
    // Session utilities
    Utils: SessionSchemas.SessionUtilities,
  },
  
  // ==================== EXPLORER STATE ====================
  // The central orchestrator containing everything
  Explorer: {
    // State layer separation
    DataCore: ExplorerSchemas.ExplorerDataCore, // Server-generated exploration data
    UIState: ExplorerSchemas.ExplorerUIState,   // Client interaction state
    Caches: ExplorerSchemas.ExplorerCaches,     // Performance caches
    SyncState: ExplorerSchemas.ExplorerSyncState, // Server-client sync management
    
    // Complete state
    Complete: ExplorerSchemas.CompleteExplorerState, // Full client window.state
    Relationships: ExplorerSchemas.ExplorerRelationships, // State relationships
    Transitions: ExplorerSchemas.ExplorerTransitions, // State change management
    
    // Explorer utilities
    Utils: ExplorerSchemas.ExplorerUtilities,
  }
};

// ==================== COMMUNICATION PATTERNS ====================

/**
 * Common Communication Patterns - High-bandwidth agent instructions
 * 
 * These patterns enable compressed communication that unpacks into large changes:
 */

const CommunicationPatterns = {
  
  // Track polymorphism handling
  "normalize Track identifiers": () => `
    Use TrackSchemas.getTrackIdentifier() to resolve the 5 identifier variants
    in priority order: trackMd5 > track_md5 > md5 > identifier > id
  `,
  
  "resolve Track metadata": () => `
    Check metadata locations in order: beetsMeta > beets > metadata > item > libraryItem
    Use TrackSchemas.getTrackTitle() for title resolution with path fallbacks
  `,
  
  "unwrap Track objects": () => `
    Handle wrapper patterns with TrackSchemas.unwrapTrack()
    Check for { track: actualTrackObject } nesting
  `,
  
  // Direction manipulation
  "flip Direction polarity": () => `
    Use DirectionSchemas.DirectionKeyUtilities.getOppositeDirection()
    Handle both PCA (_positive/_negative) and semantic (faster/slower) opposites
  `,
  
  "get Direction type": () => `
    Use DirectionSchemas.DirectionKeyUtilities.getDirectionType()
    Returns classification for UI styling: rhythmic_core, tonal_pca, etc.
  `,
  
  "cycle through Direction stack": () => `
    Navigate through sampleTracks array representing directional relationship
    Stack contains nearest, furthest, and random tracks showing dimension change
  `,
  
  // Card state management
  "separate Card data from UI state": () => `
    CardData (immutable): trackMd5, directionKey, totalTracks, stack contents
    CardUIState (mutable): trackIndex, selection, animation, layout positions
  `,
  
  "cycle Card stack": () => `
    Increment trackIndex in CardUIState, update remainingCounts in Explorer UIState
    Handle stack bounds and wrap-around logic
  `,
  
  // Session state navigation
  "check Session health": () => `
    Use SessionSchemas.SessionUtilities.isSessionHealthy()
    Checks recent activity + client connections, not just wrapper existence
  `,
  
  "get current Session track": () => `
    SessionUtilities.getCurrentTrack() handles both wrapper and mixer access patterns
    Returns from audioState.currentTrack or mixer.currentTrack
  `,
  
  // Explorer state operations
  "validate Explorer consistency": () => `
    Use ExplorerSchemas.ExplorerUtilities.checkConsistency()
    Validates direction existence, stack bounds, track cache consistency
  `,
  
  "sync Explorer state": () => `
    Check ExplorerUtilities.needsServerSync() for SSE connection status
    Handle data freshness, pending syncs, connection errors
  `,
};

// ==================== EXPORTS ====================

module.exports = {
  // All schemas organized by domain
  ...TSNotFYISchemas,
  
  // Individual schema modules for specific imports
  TrackSchemas,
  DirectionSchemas, 
  CardSchemas,
  SessionSchemas,
  ExplorerSchemas,
  
  // Communication patterns for agent instructions
  CommunicationPatterns,
  
  // Master schema collection
  TSNotFYI: TSNotFYISchemas,
};