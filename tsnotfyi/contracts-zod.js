// Backend contract validation using Zod
// Validates data at API boundaries to catch shape mismatches early

const { z } = require('zod');

// =============================================================================
// AudioMixer Metadata Shape
// =============================================================================

// What the audioMixer reports as currently/next playing
// This is the source of truth for what's actually in the audio pipeline
const MixerMetadata = z.object({
  identifier: z.string(),
  title: z.string().nullable().optional(),
  artist: z.string().nullable().optional(),
  album: z.string().nullable().optional(),
  path: z.string().nullable().optional()
});

// =============================================================================
// Core Track Shapes
// =============================================================================

const TrackSummary = z.object({
  identifier: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string().optional(),
  year: z.number().optional(),
  albumCover: z.string().optional(),
  duration: z.number().optional(),
  distance: z.number().optional()
});

// =============================================================================
// Explorer Response Shapes
// =============================================================================

const NextTrack = z.object({
  directionKey: z.string(),
  direction: z.string(),
  track: TrackSummary
});

const DirectionSummary = z.object({
  direction: z.string(),
  domain: z.string().optional(),
  component: z.string().optional(),
  polarity: z.string().optional(),
  sampleTracks: z.array(TrackSummary),
  trackCount: z.number(),
  hasOpposite: z.boolean().optional(),
  isOutlier: z.boolean().optional(),
  diversityScore: z.number().optional(),
  oppositeDirection: z.object({
    key: z.string(),
    direction: z.string(),
    component: z.string().optional(),
    polarity: z.string().optional(),
    sampleTracks: z.array(TrackSummary),
    trackCount: z.number()
  }).optional()
});

const ExplorerResponse = z.object({
  currentTrack: TrackSummary,
  directions: z.record(z.string(), DirectionSummary),
  nextTrack: NextTrack.nullable()
});

// =============================================================================
// SSE Heartbeat Shapes (for future use)
// =============================================================================

const HeartbeatCurrentTrack = z.object({
  identifier: z.string(),
  title: z.string(),
  artist: z.string(),
  startTime: z.number(),
  durationMs: z.number()
});

const HeartbeatTiming = z.object({
  elapsed: z.number(),
  remaining: z.number(),
  progress: z.number()
});

const HeartbeatNextTrack = z.object({
  identifier: z.string(),
  title: z.string(),
  artist: z.string(),
  directionKey: z.string().nullable()
});

const HeartbeatPayload = z.object({
  type: z.literal('heartbeat'),
  timestamp: z.number(),
  reason: z.string(),
  fingerprint: z.string(),
  currentTrack: HeartbeatCurrentTrack,
  timing: HeartbeatTiming,
  nextTrack: HeartbeatNextTrack.nullable()
});

// =============================================================================
// Validation Helpers
// =============================================================================

/**
 * Validate data against schema, log violations, return data unchanged
 * Use at API boundaries to catch issues without breaking flow
 */
function validateOrWarn(schema, data, label) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const flat = result.error.flatten();
    console.error(`❌ Contract violation [${label}]:`, JSON.stringify(flat, null, 2));
  }
  return data;
}

/**
 * Validate data against schema, throw on violation
 * Use in tests or when you want hard failures
 */
function validateOrThrow(schema, data, label) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const flat = result.error.flatten();
    throw new Error(`Contract violation [${label}]: ${JSON.stringify(flat)}`);
  }
  return result.data;
}

/**
 * Check if data matches schema without logging
 * Returns { success, data?, error? }
 */
function validate(schema, data) {
  return schema.safeParse(data);
}

module.exports = {
  // Schemas
  MixerMetadata,
  TrackSummary,
  NextTrack,
  DirectionSummary,
  ExplorerResponse,
  HeartbeatCurrentTrack,
  HeartbeatTiming,
  HeartbeatNextTrack,
  HeartbeatPayload,
  // Helpers
  validateOrWarn,
  validateOrThrow,
  validate
};
