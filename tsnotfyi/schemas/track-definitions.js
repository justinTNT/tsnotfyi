// Track Object Definitions - Mapping the Polymorphic Reality
// Pure type definitions for shared lexicon - no validation, just clarity

const { z } = require('zod');

// ==================== CORE TRACK PROPERTIES ====================

const TrackIdentifierCore = z.object({
  // The 5 ways to access track identifier (resolution order from page.js:134-142)
  trackMd5: z.string().optional(),      // Primary in some contexts
  track_md5: z.string().optional(),     // Underscore variant  
  md5: z.string().optional(),           // Short variant
  identifier: z.string().optional(),    // Database standard
  id: z.string().optional(),            // Generic fallback
});

const TrackMetadataCore = z.object({
  title: z.string().optional(),
  artist: z.string().optional(), 
  album: z.string().optional(),
  year: z.union([z.string(), z.number()]).optional(),
  path: z.string().optional(),
  duration: z.number().optional(),       // Sometimes 'length'
  length: z.number().optional(),         // Database field name
  albumCover: z.string().optional(),
});

const AudioFeatures = z.object({
  // Rhythmic features
  bpm: z.number().optional(),
  danceability: z.number().optional(),
  onset_rate: z.number().optional(),
  beat_punch: z.number().optional(),
  
  // Tonal features  
  tonal_clarity: z.number().optional(),
  tuning_purity: z.number().optional(),
  fifths_strength: z.number().optional(),
  chord_strength: z.number().optional(),
  chord_change_rate: z.number().optional(),
  
  // Spectral features
  spectral_centroid: z.number().optional(),
  spectral_rolloff: z.number().optional(),
  spectral_kurtosis: z.number().optional(),
  spectral_energy: z.number().optional(),
  spectral_flatness: z.number().optional(),
  spectral_slope: z.number().optional(),
  
  // Production features
  sub_drive: z.number().optional(),
  air_sizzle: z.number().optional(),
  
  // Calculated features
  opb: z.number().optional(),
  pulse_cohesion: z.number().optional(),
  crest: z.number().optional(),
  entropy: z.number().optional(),
});

const PCACoordinates = z.object({
  primary_d: z.number().optional(),
  tonal: z.array(z.number()).length(3).optional(),      // [pc1, pc2, pc3]
  spectral: z.array(z.number()).length(3).optional(),   // [pc1, pc2, pc3]
  rhythmic: z.array(z.number()).length(3).optional(),   // [pc1, pc2, pc3]
  
  // Sometimes stored as individual fields
  tonal_pc1: z.number().optional(),
  tonal_pc2: z.number().optional(), 
  tonal_pc3: z.number().optional(),
  spectral_pc1: z.number().optional(),
  spectral_pc2: z.number().optional(),
  spectral_pc3: z.number().optional(),
  rhythmic_pc1: z.number().optional(),
  rhythmic_pc2: z.number().optional(),
  rhythmic_pc3: z.number().optional(),
});

// ==================== METADATA LOCATION VARIATIONS ====================

// The 6+ places where track metadata can live (from helpers.js:48-113)
const BeetsMetadata = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  path: z.string().optional(),
  item: z.object({
    path: z.string().optional(),
    file: z.string().optional(),
  }).optional(),
});

const MetadataLocations = z.object({
  beetsMeta: BeetsMetadata.optional(),          // Primary location
  beets: BeetsMetadata.optional(),              // Alternative location
  metadata: TrackMetadataCore.optional(),       // Generic metadata
  item: z.object({                              // Item wrapper
    path: z.string().optional(),
    file: z.string().optional(),
  }).optional(),
  libraryItem: z.object({                       // Library item wrapper
    path: z.string().optional(), 
    file: z.string().optional(),
  }).optional(),
});

// ==================== CONTEXT-SPECIFIC TRACK TYPES ====================

// Database track (from kd-tree.js)
const DatabaseTrack = TrackIdentifierCore.merge(TrackMetadataCore).extend({
  features: AudioFeatures.optional(),
  pca: PCACoordinates.optional(), 
  love: z.number().optional(),
  hate: z.number().optional(),
  beets_meta: z.record(z.any()).optional(),     // Raw beets JSON
});

// Search result track (from server.js search endpoint)
const SearchResultTrack = z.object({
  md5: z.string(),                              // Always present in search
  path: z.string(),
  filename: z.string(), 
  directory: z.string(),
  segments: z.array(z.string()),
  albumCover: z.string(),
  title: z.string(),
  artist: z.string(), 
  album: z.string(),
  year: z.string(),
  score: z.number(),                            // Search relevance score
  displayText: z.string(),
  searchableText: z.string(),
});

// Explorer track (in direction.sampleTracks)
const ExplorerTrack = TrackIdentifierCore.merge(TrackMetadataCore).extend({
  features: AudioFeatures.optional(),
  pca: PCACoordinates.optional(),
  distance: z.number().optional(),              // Distance from current track
  distanceSlices: z.object({                    // Feature contribution analysis
    kind: z.enum(['pca', 'feature']),
    domain: z.string().optional(),
    reference: z.object({
      key: z.string(),
      distance: z.number(),
    }),
    total: z.number(),
    slices: z.array(z.any()),                   // Complex breakdown structure
  }).optional(),
});

// Client-side track (with UI state)
const ClientTrack = TrackIdentifierCore.merge(TrackMetadataCore).merge(MetadataLocations).extend({
  features: AudioFeatures.optional(),
  pca: PCACoordinates.optional(),
  directionKey: z.string().optional(),          // Associated direction
  distance: z.number().optional(),
  // Sometimes wrapped in track property
  track: z.lazy(() => ClientTrack).optional(),  // Recursive wrapper pattern
});

// ==================== WRAPPER PATTERNS ====================

// The dreaded wrapper pattern where tracks are nested
const WrappedTrack = z.object({
  track: z.union([DatabaseTrack, SearchResultTrack, ExplorerTrack, ClientTrack]),
});

// ==================== UNION TYPES ====================

// All possible track variations
const AnyTrack = z.union([
  DatabaseTrack,
  SearchResultTrack, 
  ExplorerTrack,
  ClientTrack,
  WrappedTrack,
]);

// ==================== UTILITY FUNCTIONS ====================

// Track identifier resolution (mirrors page.js:134-142)
function getTrackIdentifier(track) {
  const keyOrder = ['trackMd5', 'track_md5', 'md5', 'identifier', 'id'];
  for (const key of keyOrder) {
    if (track[key]) return track[key];
  }
  return null;
}

// Track unwrapping (handle wrapper patterns)
function unwrapTrack(track) {
  return track?.track || track;
}

// Title resolution (mirrors helpers.js:48-113)
function getTrackTitle(track) {
  const unwrapped = unwrapTrack(track);
  
  // Direct title
  if (unwrapped.title?.trim()) return unwrapped.title.trim();
  
  // Beets metadata locations
  if (unwrapped.beetsMeta?.title?.trim()) return unwrapped.beetsMeta.title.trim();
  if (unwrapped.beets?.title?.trim()) return unwrapped.beets.title.trim();
  if (unwrapped.metadata?.title?.trim()) return unwrapped.metadata.title.trim();
  
  // File path fallbacks (simplified)
  const pathFields = ['fileName', 'filename', 'file', 'filepath', 'filePath', 'path'];
  for (const field of pathFields) {
    if (unwrapped[field]) {
      const stem = extractFileStem(unwrapped[field]);
      if (stem) return stem;
    }
  }
  
  return 'Unknown Track';
}

function extractFileStem(path) {
  if (!path) return null;
  const filename = path.split(/[/\\]/).pop();
  const dotIndex = filename?.lastIndexOf('.');
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

module.exports = {
  // Core schemas
  TrackIdentifierCore,
  TrackMetadataCore,
  AudioFeatures,
  PCACoordinates,
  MetadataLocations,
  
  // Context-specific schemas
  DatabaseTrack,
  SearchResultTrack,
  ExplorerTrack, 
  ClientTrack,
  WrappedTrack,
  AnyTrack,
  
  // Utilities
  getTrackIdentifier,
  unwrapTrack,
  getTrackTitle,
  extractFileStem,
};