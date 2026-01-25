// helpers: small utilities that are kind of independent but not really
import { state } from './globals.js';

export const VAE_LATENT_NAMES = [
    'Hidden Doorway',
    'Clandestine Passage',
    'Secret Path',
    'Whispered Corridor',
    'Shrouded Walkway',
    'Candlelit Arcade',
    'Phantom Stairwell',
    'Midnight Causeway'
];

export function variantFromDirectionType(directionType) {
    const variantMap = {
        rhythmic_core: 'red-variant',
        rhythmic_pca: 'red-variant',
        tonal_core: 'green-variant',
        tonal_pca: 'green-variant',
        spectral_core: 'blue-variant',
        spectral_pca: 'blue-variant',
        outlier: 'yellow-variant'
    };
    return variantMap[directionType] || 'yellow-variant';
}

// Categorize direction into 7 distinct types for color coding
export function getDirectionType(directionKey) {
    // 7 categories: Core vs PCA for rhythmic/tonal/spectral, plus outliers
    if (directionKey.includes('rhythmic_pc') || (directionKey.includes('pc') && directionKey.includes('rhythmic'))) {
        return 'rhythmic_pca'; // Rhythmic PCA directions
    } else if (directionKey.includes('rhythmic') || directionKey.includes('bpm') || directionKey.includes('dance') || directionKey.includes('onset')) {
        return 'rhythmic_core'; // Core rhythmic features
    } else if (directionKey.includes('tonal_pc') || (directionKey.includes('pc') && directionKey.includes('tonal'))) {
        return 'tonal_pca'; // Tonal PCA directions
    } else if (directionKey.includes('tonal') || directionKey.includes('chord') || directionKey.includes('tuning') || directionKey.includes('fifths')) {
        return 'tonal_core'; // Core tonal features
    } else if (directionKey.includes('spectral_pc') || (directionKey.includes('pc') && directionKey.includes('spectral'))) {
        return 'spectral_pca'; // Spectral PCA directions
    } else if (directionKey.includes('spectral') || directionKey.includes('centroid') || directionKey.includes('rolloff') || directionKey.includes('flatness')) {
        return 'spectral_core'; // Core spectral features
    } else {
        return 'outlier'; // Outliers, entropy, crest, and miscellaneous
    }
}



// Format direction names for display using meaningful lexicon
export function formatDirectionName(directionKey) {
    // Safety check for undefined directionKey
    if (!directionKey) {
        console.error('formatDirectionName called with undefined directionKey');
        return 'Unknown Direction';
    }

    // Mapping from technical PCA keys to meaningful direction names
    // Rim curvature indicates positive/negative, so we can remove directional words
    const directionLexicon = {
        // Primary musical axes - let rim indicate direction
        'faster': 'Tempo',
        'slower': 'Tempo',
        'brighter': 'Brightness',
        'darker': 'Brightness',
        'more_energetic': 'Energy',
        'calmer': 'Energy',
        'more_danceable': 'More Jiggy',
        'less_danceable': 'Less Jiggy',
        'more_tonal': 'Tonality',
        'more_atonal': 'Tonality',
        'more_complex': 'Complexity',
        'simpler': 'Complexity',
        'more_punchy': 'Punch',
        'smoother': 'Punch',
        'denser_onsets': 'More Events',
        'sparser_onsets': 'Fewer Events',
        'purer_tuning': 'Cleaner Pitch',
        'impurer_tuning': 'Looser Pitch',
        'stronger_chords': 'Harmony Focus',
        'weaker_chords': 'Melody Focus',
        'more_air_sizzle': 'Crisp High End',
        'less_air_sizzle': 'Warm Mids',

        // PCA-derived axes with meaningful placeholder names
        'spectral_pc1_positive': 'Spectral Shift',
        'spectral_pc1_negative': 'Spectral Counter',
        'spectral_pc2_positive': 'Harmonic Rise',
        'spectral_pc2_negative': 'Harmonic Fall',
        'spectral_pc3_positive': 'Texture Expand',
        'spectral_pc3_negative': 'Texture Focus',

        'tonal_pc1_positive': 'Tonal Drift',
        'tonal_pc1_negative': 'Tonal Shift',
        'tonal_pc2_positive': 'Modal Rise',
        'tonal_pc2_negative': 'Modal Change',
        'tonal_pc3_positive': 'Chord Flow',
        'tonal_pc3_negative': 'Chord Shift',

        'rhythmic_pc1_positive': 'Pattern Evolve',
        'rhythmic_pc1_negative': 'Pattern Change',
        'rhythmic_pc2_positive': 'Rhythm Shift',
        'rhythmic_pc2_negative': 'Rhythm Morph',
        'rhythmic_pc3_positive': 'Beat Transform',
        'rhythmic_pc3_negative': 'Beat Reshape',

        // Primary discriminator directions
        'primary_d_positive': 'Broader',
        'primary_d_negative': 'Narrower',

        // Generic PCA fallbacks
        'pc1_positive': 'Forward Shift',
        'pc1_negative': 'Reverse Shift',
        'pc2_positive': 'Mode Rise',
        'pc2_negative': 'Mode Change',
        'pc3_positive': 'Flow Evolve',
        'pc3_negative': 'Flow Transform',

        'danceability_positive': 'More Jiggy',
        'danceability_negative': 'Less Jiggy'
    };

    // Check for VAE latent keys
    const vaeMatch = directionKey.match(/^vae_latent_(\d+)_(positive|negative)$/);
    if (vaeMatch) {
        const index = parseInt(vaeMatch[1], 10);
        const baseName = VAE_LATENT_NAMES[index] || `Latent Axis ${index + 1}`;
        return baseName;
    }

    // Check if we have a specific mapping
    if (directionLexicon[directionKey]) {
        return directionLexicon[directionKey];
    }

    // Fallback: clean up the key name and remove directional indicators (rim shows direction)
    const cleaned = directionKey
        .replace(/_/g, ' ')  // Replace underscores with spaces
        .replace(/\bpc\d+\b/g, 'axis')  // Replace pc1/pc2/pc3 with 'axis'
        .replace(/\b(positive|negative|forward|return)\b/g, '')  // Remove directional words
        .replace(/\s+/g, ' ')  // Clean up multiple spaces
        .trim()  // Remove leading/trailing spaces
        .replace(/\b\w/g, l => l.toUpperCase());  // Capitalize first letter of each word

    return cleaned.replace(/Danceability/gi, 'Jiggy');
}


// Detect if a direction is negative (should have inverted rim)
export function isNegativeDirection(directionKey) {
    if (!directionKey || typeof directionKey !== 'string') {
        return false;
    }

    // Check for PCA negative directions
    if (directionKey.includes('_negative')) {
        return true;
    }

    // Check for traditional negative directions
    const negativeDirections = [
        'slower', 'darker', 'calmer', 'less_danceable', 'sparser_onsets', 'smoother_beats',
        'more_atonal', 'looser_tuning', 'weaker_fifths', 'weaker_chords', 'slower_changes',
        'smoother', 'simpler', 'narrower_spectrum', 'flatter_spectrum', 'more_tonal_spectrum',
        'less_bass', 'less_air'
    ];
    return negativeDirections.includes(directionKey);
}


// Get the opposite direction for a given direction key
export function getOppositeDirection(directionKey) {
    if (!directionKey || typeof directionKey !== 'string') {
        return null;
    }

    const trimmedKey = directionKey.trim();
    const suffixMatch = trimmedKey.match(/^(.*?)(\s+\d+)$/);
    const baseKey = suffixMatch ? suffixMatch[1] : trimmedKey;
    const numericSuffix = suffixMatch ? suffixMatch[2] : '';

    const resolveOppositeBase = (key) => {
        if (!key) return null;

        if (key.includes('_positive')) {
            return key.replace('_positive', '_negative');
        }
        if (key.includes('_negative')) {
            return key.replace('_negative', '_positive');
        }

        const oppositeDirections = {
            'faster': 'slower',
            'slower': 'faster',
            'brighter': 'darker',
            'darker': 'brighter',
            'more_energetic': 'calmer',
            'calmer': 'more_energetic',
            'more_danceable': 'less_danceable',
            'less_danceable': 'more_danceable',
            'more_tonal': 'more_atonal',
            'more_atonal': 'more_tonal',
            'more_complex': 'simpler',
            'simpler': 'more_complex',
            'more_punchy': 'smoother',
            'smoother': 'more_punchy'
        };
        return oppositeDirections[key] || null;
    };

    const oppositeBase = resolveOppositeBase(baseKey);
    if (!oppositeBase) {
        return null;
    }

    if (!numericSuffix) {
        return oppositeBase;
    }

    const candidateWithSuffix = `${oppositeBase}${numericSuffix}`;
    const directionMap = state && state.latestExplorerData
        ? state.latestExplorerData.directions
        : null;

    if (directionMap && directionMap[candidateWithSuffix]) {
        return candidateWithSuffix;
    }

    if (directionMap && directionMap[oppositeBase]) {
        return oppositeBase;
    }

    if (directionMap) {
        const suffixNumber = numericSuffix.trim();
        const alternate = Object.keys(directionMap).find(key => {
            if (!key.startsWith(oppositeBase)) return false;
            const altMatch = key.match(/^(.*?)(\s+\d+)$/);
            if (!altMatch) return false;
            return altMatch[1] === oppositeBase && altMatch[2] && altMatch[2].trim() === suffixNumber;
        });
        if (alternate) {
            return alternate;
        }
    }

    return oppositeBase;
}


// Check if the next track direction has an opposite direction available in current SSE data
export function hasOppositeDirection(currentDirectionKey, explorerData) {
    // Outliers never have opposite directions
    if (explorerData.directions && explorerData.directions[currentDirectionKey]) {
        const direction = explorerData.directions[currentDirectionKey];
        if (direction.isOutlier) {
            return false; // Outliers don't have reverse pairs
        }
        return direction.hasOpposite === true;
    }
    return false;
}


export function isSwappedOppositeDirection(currentDirectionKey, explorerData) {
    // Check if any other direction has this as its opposite
    if (!explorerData.directions) return false;

    for (const [dirKey, dirData] of Object.entries(explorerData.directions)) {
        if (dirData.oppositeDirection && getOppositeDirection(dirKey) === currentDirectionKey) {
            return true;
        }
    }
    return false;
}


// ====== Visualization Helper ======
export function hsl(h, s, l) {
    const c = new THREE.Color();
    c.setHSL(((h % 360) + 360) % 360 / 360, s, l);
    return c;
}


// Get bright tinted color and glow color for 7-category system
export function getDirectionColor(directionType, dimensionKey) {
    // Helper function to convert HSL to hex
    const hslToHex = (h, s, l) => {
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs((h / 60) % 2 - 1));
        const m = l - c / 2;
        let r, g, b;

        if (0 <= h && h < 60) { r = c; g = x; b = 0; }
        else if (60 <= h && h < 120) { r = x; g = c; b = 0; }
        else if (120 <= h && h < 180) { r = 0; g = c; b = x; }
        else if (180 <= h && h < 240) { r = 0; g = x; b = c; }
        else if (240 <= h && h < 300) { r = x; g = 0; b = c; }
        else if (300 <= h && h < 360) { r = c; g = 0; b = x; }

        r = Math.round((r + m) * 255).toString(16).padStart(2, '0');
        g = Math.round((g + m) * 255).toString(16).padStart(2, '0');
        b = Math.round((b + m) * 255).toString(16).padStart(2, '0');
        return `#${r}${g}${b}`;
    };

    const clamp01 = (value) => Math.max(0, Math.min(1, value));
    const wrapHue = (hue) => ((hue % 360) + 360) % 360;

    const NEGATIVE_OVERRIDES = {
        rhythmic_core: {
            borderHueShift: 25,
            glowHueShift: 20,
            borderSaturationScale: 0.9,
            glowSaturationScale: 0.85,
            borderLightnessDelta: 0.08,
            glowLightnessDelta: 0.05
        },
        tonal_core: {
            borderHueShift: 52,
            glowHueShift: 55,
            borderSaturationScale: 0.82,
            glowSaturationScale: 0.8,
            borderLightnessDelta: 0.06,
            glowLightnessDelta: 0.05
        }
    };

    // ANALOGOUS COMPLEMENTARY PAIRS COLOR SYSTEM
    // Implementation: Well-spaced primaries (51.4° apart) with analogous reverse variants
    // Each reverse = primary + 60° hue shift + reduced saturation + increased lightness
    // Ensures: all primaries maximally distinct, each reverse closest to own primary, all 14 colors distinguishable
    const baseColors = {
        rhythmic_core: {     // Red-orange primary: 30°
            border: hslToHex(30, 1.0, 0.75),   // Ultra bright red-orange
            glow: hslToHex(30, 1.0, 0.65)      // Vivid red-orange
        },
        rhythmic_pca: {      // Orange-yellow primary: 60°
            border: hslToHex(60, 1.0, 0.75),   // Ultra bright orange-yellow
            glow: hslToHex(60, 1.0, 0.65)      // Vivid orange-yellow
        },
        tonal_core: {        // Green primary: 103°
            border: hslToHex(103, 1.0, 0.75),  // Ultra bright green
            glow: hslToHex(103, 1.0, 0.65)     // Vivid green
        },
        tonal_pca: {         // Cyan primary: 154°
            border: hslToHex(154, 1.0, 0.75),  // Ultra bright cyan
            glow: hslToHex(154, 1.0, 0.65)     // Vivid cyan
        },
        spectral_core: {     // Blue primary: 206°
            border: hslToHex(206, 1.0, 0.75),  // Ultra bright blue
            glow: hslToHex(206, 1.0, 0.65)     // Vivid blue
        },
        spectral_pca: {      // Purple primary: 257°
            border: hslToHex(257, 1.0, 0.75),  // Ultra bright purple
            glow: hslToHex(257, 1.0, 0.65)     // Vivid purple
        },
        outlier: {           // Magenta primary: 309°
            border: hslToHex(309, 1.0, 0.75),  // Ultra bright magenta
            glow: hslToHex(309, 1.0, 0.65)     // Vivid magenta
        }
    };

    // Get base colors for the direction type
    const colors = baseColors[directionType] || baseColors.outlier;

    // Detect polarity and apply variation
    const isNegative = (dimensionKey.includes('_negative') ||
                      dimensionKey.includes('negative_') ||
                      dimensionKey.includes('slower') ||
                      dimensionKey.includes('less_') ||
                      dimensionKey.includes('lower') ||
                      dimensionKey.includes('_force_negative')) &&
                      !dimensionKey.includes('_force_primary'); // Override: force primary colors

    if (isNegative) {
        // ANALOGOUS COMPLEMENTARY PAIRS: Generate reverse colors directly from base hues
        // Formula: primary + 20° hue shift + reduced saturation + increased lightness
        let baseHue, baseSaturation, baseLightness, glowSaturation, glowLightness;

        // Get base values for each direction type (matching the primary colors above)
        switch (directionType) {
            case 'rhythmic_core':
                baseHue = 30; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'rhythmic_pca':
                baseHue = 60; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'tonal_core':
                baseHue = 103; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'tonal_pca':
                baseHue = 154; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'spectral_core':
                baseHue = 206; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'spectral_pca':
                baseHue = 257; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            case 'outlier':
                baseHue = 309; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
            default:
                baseHue = 309; baseSaturation = 1.0; baseLightness = 0.75;
                glowSaturation = 1.0; glowLightness = 0.65; break;
        }

        // Apply analogous complementary formula
        const override = NEGATIVE_OVERRIDES[directionType] || {};

        const borderHueShift = override.borderHueShift !== undefined ? override.borderHueShift : 60;
        const glowHueShift = override.glowHueShift !== undefined ? override.glowHueShift : 60;

        const borderSaturationScale = override.borderSaturationScale !== undefined ? override.borderSaturationScale : 0.7;
        const glowSaturationScale = override.glowSaturationScale !== undefined ? override.glowSaturationScale : 0.7;

        const borderLightnessDelta = override.borderLightnessDelta !== undefined ? override.borderLightnessDelta : 0.1;
        const glowLightnessDelta = override.glowLightnessDelta !== undefined ? override.glowLightnessDelta : 0.1;

        const borderHue = wrapHue(baseHue + borderHueShift);
        const glowHue = wrapHue(baseHue + glowHueShift);

        const reducedSaturation = clamp01(baseSaturation * borderSaturationScale);
        const increasedLightness = clamp01(baseLightness + borderLightnessDelta);

        const reducedGlowSaturation = clamp01(glowSaturation * glowSaturationScale);
        const increasedGlowLightness = clamp01(glowLightness + glowLightnessDelta);

        return {
            border: hslToHex(borderHue, reducedSaturation, increasedLightness),
            glow: hslToHex(glowHue, reducedGlowSaturation, increasedGlowLightness)
        };
    }

    // Return original bright colors for positive directions
    console.log(`🎨 getDirectionColor: ${dimensionKey} (${directionType}) -> isNegative=${isNegative}, colors=`, colors);
    return colors;
}

// Expose globally for cross-module access and console debugging
if (typeof window !== 'undefined') {
    window.hsl = hsl;
    window.variantFromDirectionType = variantFromDirectionType;
    window.getDirectionType = getDirectionType;
    window.formatDirectionName = formatDirectionName;
    window.isNegativeDirection = isNegativeDirection;
    window.getOppositeDirection = getOppositeDirection;
    window.hasOppositeDirection = hasOppositeDirection;
    window.isSwappedOppositeDirection = isSwappedOppositeDirection;
    window.getDirectionColor = getDirectionColor;
    window.VAE_LATENT_NAMES = VAE_LATENT_NAMES;
}
