// Direction Object Definitions - Musical Exploration Structure
// Pure type definitions for shared lexicon - no validation, just clarity

const { z } = require('zod');
const { AnyTrack, ExplorerTrack } = require('./track-definitions');

// ==================== DIRECTION DOMAINS & TYPES ====================

// Direction domains classify the type of musical analysis
const DirectionDomain = z.enum([
  'tonal',        // Harmonic, chord-based analysis
  'spectral',     // Frequency-based analysis  
  'rhythmic',     // Timing and beat-based analysis
  'original',     // Original feature-based (not PCA)
]);

// Direction components indicate which PCA dimension
const DirectionComponent = z.enum([
  'pc1',          // Principal Component 1
  'pc2',          // Principal Component 2  
  'pc3',          // Principal Component 3
  'feature',      // Original feature (for domain=original)
]);

// Direction polarity indicates the direction along the axis
const DirectionPolarity = z.enum([
  'positive',     // Moving toward higher values
  'negative',     // Moving toward lower values
]);

// Direction type classification for UI styling (from tools.js:16-34)
const DirectionType = z.enum([
  'rhythmic_core',    // Core rhythmic features
  'rhythmic_pca',     // Rhythmic PCA directions
  'tonal_core',       // Core tonal features  
  'tonal_pca',        // Tonal PCA directions
  'spectral_core',    // Core spectral features
  'spectral_pca',     // Spectral PCA directions
  'outlier',          // Miscellaneous/low-sample directions
]);

// ==================== DIRECTION KEY PATTERNS ====================

// Direction keys follow predictable patterns
const DirectionKeyPattern = z.union([
  // PCA-based keys: "domain_pc1_polarity"
  z.string().regex(/^(tonal|spectral|rhythmic)_pc[123]_(positive|negative)$/),
  
  // Feature-based keys: "feature_polarity" 
  z.string().regex(/^(faster|slower|brighter|darker|more_energetic|calmer)$/),
  z.string().regex(/^(more_danceable|less_danceable|more_tonal|more_atonal)$/),
  z.string().regex(/^(more_complex|simpler|more_punchy|smoother)$/),
  
  // Original feature keys with _positive/_negative
  z.string().regex(/^[a-z_]+_(positive|negative)$/),
]);

// ==================== CORE DIRECTION STRUCTURE ====================

const DirectionCore = z.object({
  direction: z.string(),                    // e.g., "faster", "complex_textured"
  description: z.string(),                  // e.g., "Tempo", "Texture vs punch"  
  domain: DirectionDomain,                  // Musical analysis domain
  component: DirectionComponent,            // PCA component or "feature"
  polarity: DirectionPolarity,              // Direction along axis
  
  // Track statistics
  trackCount: z.number(),                   // Number of tracks in this direction
  totalNeighborhoodSize: z.number(),        // Total tracks considered
  splitRatio: z.number(),                   // trackCount/totalNeighborhoodSize
  
  // Quality metrics
  diversityScore: z.number(),               // Calculated diversity metric
  isOutlier: z.boolean(),                   // True if trackCount < 3
  
  // Track samples for this direction
  sampleTracks: z.array(ExplorerTrack),     // Tracks in this direction
  originalSampleTracks: z.array(z.any()),   // Raw track data before formatting
});

// ==================== BIDIRECTIONAL DIRECTIONS ====================

// Directions can embed their opposite direction (from prioritizeBidirectionalDirections)
const BidirectionalDirection = DirectionCore.extend({
  hasOpposite: z.boolean().default(false),  // Whether this direction has a paired opposite
  oppositeDirection: z.lazy(() => z.union([
    DirectionCore.extend({
      key: z.string(),                       // Key of the opposite direction
      hasOpposite: z.boolean().default(true),
      sampleTracks: z.array(ExplorerTrack), // Full track list for opposite
    }),
    z.null()
  ])).optional(),
});

// ==================== COMPLETE DIRECTION OBJECT ====================

const Direction = BidirectionalDirection;

// Direction map as it appears in explorer data
const DirectionMap = z.record(z.string(), Direction);

// ==================== DIRECTION COLLECTIONS ====================

// Explorer data directions structure  
const ExplorerDirections = z.object({
  directions: DirectionMap,                  // All available directions keyed by direction key
  nextTrack: z.object({                     // Recommended next track
    directionKey: z.string(),               // Which direction was selected
    direction: z.string(),                  // Direction name
    track: AnyTrack,                        // The recommended track
  }).optional(),
  diversityMetrics: z.record(z.any()).optional(), // Overall diversity statistics
  resolution: z.enum(['microscope', 'magnifying_glass', 'binoculars']).optional(),
});

// ==================== DIRECTION KEY UTILITIES ====================

// Direction key resolution and manipulation
const DirectionKeyUtilities = {
  // Get direction type for styling (from tools.js:17-34)
  getDirectionType: (directionKey) => {
    if (directionKey.includes('rhythmic_pc') || (directionKey.includes('pc') && directionKey.includes('rhythmic'))) {
      return 'rhythmic_pca';
    } else if (directionKey.includes('rhythmic') || directionKey.includes('bpm') || directionKey.includes('dance') || directionKey.includes('onset')) {
      return 'rhythmic_core';
    } else if (directionKey.includes('tonal_pc') || (directionKey.includes('pc') && directionKey.includes('tonal'))) {
      return 'tonal_pca';
    } else if (directionKey.includes('tonal') || directionKey.includes('chord') || directionKey.includes('tuning') || directionKey.includes('fifths')) {
      return 'tonal_core';  
    } else if (directionKey.includes('spectral_pc') || (directionKey.includes('pc') && directionKey.includes('spectral'))) {
      return 'spectral_pca';
    } else if (directionKey.includes('spectral') || directionKey.includes('centroid') || directionKey.includes('rolloff') || directionKey.includes('flatness')) {
      return 'spectral_core';
    } else {
      return 'outlier';
    }
  },
  
  // Check if direction is negative polarity (from tools.js:125-143)
  isNegativeDirection: (directionKey) => {
    if (!directionKey || typeof directionKey !== 'string') return false;
    
    if (directionKey.includes('_negative')) return true;
    
    const negativeDirections = [
      'slower', 'darker', 'calmer', 'less_danceable', 'sparser_onsets', 'smoother_beats',
      'more_atonal', 'looser_tuning', 'weaker_fifths', 'weaker_chords', 'slower_changes',
      'smoother', 'simpler', 'narrower_spectrum', 'flatter_spectrum', 'more_tonal_spectrum',
      'less_bass', 'less_air'
    ];
    return negativeDirections.includes(directionKey);
  },
  
  // Get opposite direction key (from tools.js:147-221)
  getOppositeDirection: (directionKey) => {
    if (!directionKey || typeof directionKey !== 'string') return null;
    
    // Handle PCA directions
    if (directionKey.includes('_positive')) {
      return directionKey.replace('_positive', '_negative');
    }
    if (directionKey.includes('_negative')) {
      return directionKey.replace('_negative', '_positive');
    }
    
    // Handle semantic directions
    const oppositeMap = {
      'faster': 'slower', 'slower': 'faster',
      'brighter': 'darker', 'darker': 'brighter',
      'more_energetic': 'calmer', 'calmer': 'more_energetic',
      'more_danceable': 'less_danceable', 'less_danceable': 'more_danceable',
      'more_tonal': 'more_atonal', 'more_atonal': 'more_tonal',
      'more_complex': 'simpler', 'simpler': 'more_complex',
      'more_punchy': 'smoother', 'smoother': 'more_punchy'
    };
    
    return oppositeMap[directionKey] || null;
  },
  
  // Format direction name for display (from tools.js:39-121)
  formatDirectionName: (directionKey) => {
    if (!directionKey) return 'Unknown Direction';
    
    const directionLexicon = {
      'faster': 'Tempo', 'slower': 'Tempo',
      'brighter': 'Brightness', 'darker': 'Brightness',
      'more_energetic': 'Energy', 'calmer': 'Energy',
      'more_danceable': 'Groove', 'less_danceable': 'Groove',
      'more_tonal': 'Tonality', 'more_atonal': 'Tonality',
      'more_complex': 'Complexity', 'simpler': 'Complexity',
      'more_punchy': 'Punch', 'smoother': 'Punch',
      // ... additional lexicon mappings
    };
    
    return directionLexicon[directionKey] || 
           directionKey.replace(/_/g, ' ')
                      .replace(/\bpc\d+\b/g, 'axis')
                      .replace(/\b(positive|negative|forward|return)\b/g, '')
                      .replace(/\s+/g, ' ')
                      .trim()
                      .replace(/\b\w/g, l => l.toUpperCase());
  }
};

module.exports = {
  // Core enums and types
  DirectionDomain,
  DirectionComponent, 
  DirectionPolarity,
  DirectionType,
  DirectionKeyPattern,
  
  // Direction schemas
  DirectionCore,
  BidirectionalDirection,
  Direction,
  DirectionMap,
  ExplorerDirections,
  
  // Utilities
  DirectionKeyUtilities,
};