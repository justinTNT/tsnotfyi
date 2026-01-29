/**
 * Deck frame builder shared between the main thread and the render worker.
 * Produces normalized explorer snapshots that are cheap to hand to the DOM renderer.
 */
(function deckFrameBuilderBootstrap(globalScope) {
    'use strict';

    function pruneEmptyStrings(value) {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === 'string') {
            return value.trim() === '' ? undefined : value;
        }
        if (Array.isArray(value)) {
            const mapped = value
                .map(item => pruneEmptyStrings(item))
                .filter(item => item !== undefined);
            return mapped;
        }
        if (typeof value === 'object') {
            const result = {};
            let hasValue = false;
            Object.entries(value).forEach(([key, val]) => {
                const sanitized = pruneEmptyStrings(val);
                if (sanitized !== undefined) {
                    result[key] = sanitized;
                    hasValue = true;
                }
            });
            return hasValue ? result : undefined;
        }
        return value;
    }

    function cloneTrackRecord(track) {
        if (!track || typeof track !== 'object') {
            return null;
        }
        const cloned = { ...track };
        const sanitized = pruneEmptyStrings(cloned);
        return sanitized || cloned;
    }

    function wrapSampleEntry(entry) {
        if (!entry) {
            return null;
        }
        if (entry.track && typeof entry.track === 'object') {
            return { track: cloneTrackRecord(entry.track) };
        }
        if (typeof entry === 'object') {
            return { track: cloneTrackRecord(entry) };
        }
        return null;
    }

    function normalizeDirectionSamples(direction) {
        if (!direction) {
            return;
        }

        if (Array.isArray(direction.sampleTracks)) {
            direction.sampleTracks = direction.sampleTracks
                .map(wrapSampleEntry)
                .filter(Boolean);

            if (direction.sampleTracks.length > 0) {
                direction.isSynthetic = false;
            }
        } else {
            direction.sampleTracks = [];
        }

        if (direction.oppositeDirection) {
            normalizeDirectionSamples(direction.oppositeDirection);
            if (Array.isArray(direction.oppositeDirection.sampleTracks) &&
                direction.oppositeDirection.sampleTracks.length > 0) {
                direction.oppositeDirection.isSynthetic = false;
            }
        }
    }

    function resolveOppositeKey(directionKey, directionMap) {
        if (!directionKey || typeof directionKey !== 'string') {
            return null;
        }
        const trimmedKey = directionKey.trim();
        const suffixMatch = trimmedKey.match(/^(.*?)(\s+\d+)$/);
        const baseKey = suffixMatch ? suffixMatch[1] : trimmedKey;
        const numericSuffix = suffixMatch ? suffixMatch[2] : '';

        const swapPositiveNegative = (key) => {
            if (key.includes('_positive')) {
                return key.replace('_positive', '_negative');
            }
            if (key.includes('_negative')) {
                return key.replace('_negative', '_positive');
            }
            return null;
        };

        const simpleOpposites = {
            faster: 'slower',
            slower: 'faster',
            brighter: 'darker',
            darker: 'brighter',
            more_energetic: 'calmer',
            calmer: 'more_energetic',
            more_danceable: 'less_danceable',
            less_danceable: 'more_danceable',
            more_tonal: 'more_atonal',
            more_atonal: 'more_tonal',
            more_complex: 'simpler',
            simpler: 'more_complex',
            more_punchy: 'smoother',
            smoother: 'more_punchy'
        };

        let oppositeBase = swapPositiveNegative(baseKey);
        if (!oppositeBase && simpleOpposites[baseKey]) {
            oppositeBase = simpleOpposites[baseKey];
        }

        if (!oppositeBase) {
            return null;
        }

        const directions = directionMap || {};
        const suffixTrimmed = numericSuffix ? numericSuffix.trim() : '';

        if (numericSuffix) {
            const suffixedCandidate = `${oppositeBase}${numericSuffix}`;
            if (directions[suffixedCandidate]) {
                return suffixedCandidate;
            }
        }

        if (directions[oppositeBase]) {
            return oppositeBase;
        }

        if (suffixTrimmed) {
            const alternate = Object.keys(directions).find((key) => {
                const match = key.match(/^(.*?)(\s+\d+)$/);
                if (!match) {
                    return false;
                }
                return match[1] === oppositeBase && match[2] && match[2].trim() === suffixTrimmed;
            });
            if (alternate) {
                return alternate;
            }
        }

        return numericSuffix ? `${oppositeBase}${numericSuffix}` : oppositeBase;
    }

    function ensureSyntheticOpposites(explorerData) {
        if (!explorerData || !explorerData.directions) {
            return;
        }

        const directionsMap = explorerData.directions;
        const processedPairs = new Set();

        const cloneSampleList = (samples = []) => (
            Array.isArray(samples)
                ? samples.map(wrapSampleEntry).filter(Boolean)
                : []
        );

        Object.entries(directionsMap).forEach(([key, direction]) => {
            if (!direction) {
                return;
            }

            const oppositeKey = resolveOppositeKey(key, directionsMap);
            if (!oppositeKey) {
                return;
            }

            const pairKey = [key, oppositeKey].sort().join('::');
            if (processedPairs.has(pairKey)) {
                return;
            }

            const baseSamples = cloneSampleList(direction.sampleTracks);
            if (!baseSamples.length) {
                return;
            }

            const oppositeDirectionEntry = directionsMap[oppositeKey];
            const hasExistingOpposite = Boolean(
                oppositeDirectionEntry &&
                Array.isArray(oppositeDirectionEntry.sampleTracks) &&
                oppositeDirectionEntry.sampleTracks.length
            );

            if (hasExistingOpposite) {
                const oppositeSamples = cloneSampleList(oppositeDirectionEntry.sampleTracks);
                direction.hasOpposite = true;
                direction.oppositeDirection = {
                    key: oppositeKey,
                    direction: oppositeDirectionEntry.direction || oppositeKey,
                    domain: oppositeDirectionEntry.domain || direction.domain || null,
                    sampleTracks: oppositeSamples,
                    generatedOpposite: false
                };

                oppositeDirectionEntry.hasOpposite = true;
                oppositeDirectionEntry.oppositeDirection = {
                    key,
                    direction: direction.direction || key,
                    domain: direction.domain || oppositeDirectionEntry.domain || null,
                    sampleTracks: baseSamples.map(wrapSampleEntry).filter(Boolean),
                    generatedOpposite: false
                };

                processedPairs.add(pairKey);
                return;
            }

            if (directionsMap[oppositeKey]?.generatedOpposite) {
                delete directionsMap[oppositeKey];
            }

            // Server filtered out the opposite (too weak) - respect that decision
            // Don't create synthetic opposites with copied tracks
            direction.hasOpposite = false;
            if (direction.oppositeDirection) {
                delete direction.oppositeDirection;
            }

            processedPairs.add(pairKey);
        });
    }

    function computeFrameMeta(explorerData) {
        const directions = explorerData?.directions || {};
        const directionKeys = Object.keys(directions);
        let trackCount = 0;

        directionKeys.forEach((key) => {
            const direction = directions[key];
            if (!direction) {
                return;
            }
            trackCount += Array.isArray(direction.sampleTracks) ? direction.sampleTracks.length : 0;
            if (direction.oppositeDirection) {
                trackCount += Array.isArray(direction.oppositeDirection.sampleTracks)
                    ? direction.oppositeDirection.sampleTracks.length
                    : 0;
            }
        });

        return {
            directionCount: directionKeys.length,
            trackCount
        };
    }

    function sanitizeExplorerPayload(raw) {
        if (!raw || typeof raw !== 'object') {
            return { directions: {} };
        }
        if (!raw.directions || typeof raw.directions !== 'object') {
            raw.directions = {};
        }
        return raw;
    }

    function buildDeckRenderFrame(payload = {}) {
        const explorerData = sanitizeExplorerPayload(payload.explorerData);

        Object.values(explorerData.directions).forEach((direction) => {
            normalizeDirectionSamples(direction);
        });

        ensureSyntheticOpposites(explorerData);

        const meta = computeFrameMeta(explorerData);
        meta.normalized = true;
        meta.normalizedAt = Date.now();
        return { explorerData, meta };
    }

    const api = {
        buildDeckRenderFrame,
        normalizeDirectionSamples,
        ensureSyntheticOpposites,
        resolveOppositeKey
    };

    if (globalScope && typeof globalScope === 'object') {
        globalScope.DeckFrameBuilder = api;
    }
})(typeof self !== 'undefined'
    ? self
    : (typeof globalThis !== 'undefined' ? globalThis : this));
