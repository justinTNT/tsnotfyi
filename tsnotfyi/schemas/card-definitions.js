// Card Data Definitions - Separating Data from UI State
// Pure type definitions for shared lexicon - no validation, just clarity

const { z } = require('zod');
const { AnyTrack } = require('./track-definitions');
const { Direction } = require('./direction-definitions');

// ==================== CARD DATA (IMMUTABLE) ====================

// Core card data that doesn't change during UI interactions
const CardDataCore = z.object({
  // Identity
  key: z.string(),                          // Unique card identifier
  cardType: z.enum(['track', 'direction']), // What kind of card this is
  
  // Track information (for track cards)
  trackMd5: z.string().optional(),          // Primary track identifier
  trackTitle: z.string().optional(),        // Display title
  trackArtist: z.string().optional(),       // Display artist
  trackAlbum: z.string().optional(),        // Display album
  trackAlbumCover: z.string().optional(),   // Cover art URL
  trackDurationSeconds: z.number().optional(), // Duration in seconds
  trackDurationDisplay: z.string().optional(), // Formatted duration "3:45"
  
  // Direction information (for direction cards)
  directionKey: z.string().optional(),      // Current direction key
  originalDirectionKey: z.string().optional(), // Base direction before transforms
  baseDirectionKey: z.string().optional(),  // Base for polarity handling
  oppositeDirectionKey: z.string().optional(), // Opposite direction key
  directionType: z.string().optional(),     // Type for styling (rhythmic_core, etc.)
  
  // Stack information (cards can represent multiple tracks)
  totalTracks: z.number().optional(),       // Total tracks available in this direction
  trackStack: z.array(AnyTrack).optional(), // All available tracks in stack
  
  // Metadata
  isNextTrack: z.boolean().default(false),  // Whether this is the "next track" card
  createdAt: z.date().optional(),           // When card data was created
});

// ==================== CARD UI STATE (MUTABLE) ====================

// UI state that changes during interactions - separate from core data
const CardUIState = z.object({
  // Current position and selection
  trackIndex: z.number().default(0),        // Current position in track stack
  isSelected: z.boolean().default(false),   // Whether card is currently selected
  
  // Layout and positioning
  clockPosition: z.number().optional(),     // Position in circular layout (0-11)
  originalClockPosition: z.number().optional(), // Original position before animations
  
  // Visual state
  scale: z.number().default(1.0),           // Current scale factor
  opacity: z.number().default(1.0),         // Current opacity
  zIndex: z.number().optional(),            // Stacking order
  
  // Animation state
  isAnimating: z.boolean().default(false),  // Whether currently animating
  animationState: z.enum(['idle', 'entering', 'leaving', 'transforming']).default('idle'),
  
  // Color and styling (derived from data but cached for performance)
  borderColor: z.string().optional(),       // Current border color
  glowColor: z.string().optional(),         // Current glow color
  oppositeBorderColor: z.string().optional(), // Color for opposite direction
  
  // Validation state
  consistencyStatus: z.enum(['valid', 'invalid', 'unknown']).default('unknown'),
  consistencySignature: z.string().optional(), // Hash for detecting changes
  
  // Force layout state (from ForceLayoutManager)
  forceLayoutNode: z.object({
    x: z.number(),                          // Force layout x position
    y: z.number(),                          // Force layout y position
    vx: z.number().default(0),              // Velocity x
    vy: z.number().default(0),              // Velocity y
    radius: z.number(),                     // Collision radius
  }).optional(),
});

// ==================== COMPLETE CARD TYPES ====================

// Track Detail Card - displays specific track information
const TrackCard = z.object({
  data: CardDataCore.extend({
    cardType: z.literal('track'),
    trackMd5: z.string(),                   // Required for track cards
    trackTitle: z.string(),                 // Required for display
    trackArtist: z.string(),                // Required for display
  }),
  uiState: CardUIState,
  
  // Track-specific UI state
  trackUIState: z.object({
    showPreview: z.boolean().default(false), // Whether preview is visible
    previewType: z.enum(['next', 'hover', 'selected']).optional(),
  }).optional(),
});

// Direction Card - displays direction with track stack
const DirectionCard = z.object({
  data: CardDataCore.extend({
    cardType: z.literal('direction'),
    directionKey: z.string(),               // Required for direction cards
    totalTracks: z.number(),                // Required for stack management
    trackStack: z.array(AnyTrack),          // Required track stack
  }),
  uiState: CardUIState,
  
  // Direction-specific UI state
  directionUIState: z.object({
    showStackIndicator: z.boolean().default(true), // Show stack size indicator
    stackPreviewVisible: z.boolean().default(false), // Stack preview visibility
    canCycle: z.boolean().default(true),    // Whether user can cycle through stack
    cycleDirection: z.enum(['forward', 'reverse']).default('forward'),
  }).optional(),
});

// ==================== CARD RELATIONSHIPS ====================

// Card-Direction relationship data
const CardDirectionRelation = z.object({
  cardKey: z.string(),                      // Card identifier
  directionKey: z.string(),                 // Direction identifier
  direction: Direction.optional(),          // Full direction object reference
  positionInDirection: z.number().optional(), // Position within direction's sample tracks
});

// Card-Track relationship data  
const CardTrackRelation = z.object({
  cardKey: z.string(),                      // Card identifier
  trackMd5: z.string(),                     // Track identifier
  track: AnyTrack.optional(),               // Full track object reference
  isCurrentlyDisplayed: z.boolean().default(false), // Whether this track is shown
  stackPosition: z.number().optional(),     // Position in card's track stack
});

// ==================== CARD COLLECTIONS ====================

// Card manager state
const CardCollection = z.object({
  cards: z.record(z.string(), z.union([TrackCard, DirectionCard])), // All cards by key
  selectedCardKey: z.string().optional(),   // Currently selected card
  nextTrackCardKey: z.string().optional(),  // Key of the "next track" card
  
  // Relationships
  cardDirectionRelations: z.array(CardDirectionRelation),
  cardTrackRelations: z.array(CardTrackRelation),
  
  // Layout state
  layoutType: z.enum(['circular', 'grid', 'force']).default('circular'),
  centerX: z.number().optional(),           // Layout center coordinates
  centerY: z.number().optional(),
});

// ==================== CARD UTILITIES ====================

const CardUtilities = {
  // Get current track for a card (handles stack cycling)
  getCurrentTrack: (card) => {
    if (card.data.cardType === 'track') {
      return { trackMd5: card.data.trackMd5, title: card.data.trackTitle, artist: card.data.trackArtist };
    }
    if (card.data.cardType === 'direction' && card.data.trackStack) {
      const currentIndex = card.uiState.trackIndex || 0;
      return card.data.trackStack[currentIndex] || null;
    }
    return null;
  },
  
  // Check if card represents multiple tracks
  isStackCard: (card) => {
    return card.data.cardType === 'direction' && (card.data.totalTracks || 0) > 1;
  },
  
  // Get remaining tracks in stack
  getRemainingCount: (card) => {
    if (card.data.cardType !== 'direction') return 0;
    const total = card.data.totalTracks || 0;
    const current = card.uiState.trackIndex || 0;
    return Math.max(0, total - current - 1);
  },
  
  // Create card key from track and direction
  createCardKey: (trackMd5, directionKey) => {
    return directionKey ? `${directionKey}_${trackMd5}` : `track_${trackMd5}`;
  },
  
  // Extract identifiers from card key
  parseCardKey: (cardKey) => {
    if (cardKey.startsWith('track_')) {
      return { trackMd5: cardKey.substring(6), directionKey: null };
    }
    const lastUnderscore = cardKey.lastIndexOf('_');
    if (lastUnderscore > 0) {
      return {
        directionKey: cardKey.substring(0, lastUnderscore),
        trackMd5: cardKey.substring(lastUnderscore + 1)
      };
    }
    return { cardKey, trackMd5: null, directionKey: null };
  },
  
  // Check if card data has changed (for consistency validation)
  hasDataChanged: (card, signature) => {
    return card.uiState.consistencySignature !== signature;
  }
};

module.exports = {
  // Core data schemas
  CardDataCore,
  CardUIState,
  
  // Complete card types
  TrackCard,
  DirectionCard,
  
  // Relationship schemas
  CardDirectionRelation,
  CardTrackRelation,
  CardCollection,
  
  // Utilities
  CardUtilities,
};