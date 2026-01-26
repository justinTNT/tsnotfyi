// Sync manager - heartbeat, server communication, session recovery
import { state, elements, audioHealth, connectionHealth, DEBUG_FLAGS } from './globals.js';
import { applyFingerprint, clearFingerprint, waitForFingerprint, composeStreamEndpoint } from './session-utils.js';
import { clearPendingExplorerLookahead, setDeckStaleFlag } from './deck-state.js';
import { exitDangerZoneVisualState } from './danger-zone.js';
import { extractNextTrackIdentifier, extractNextTrackDirection } from './explorer-utils.js';
import { startProgressAnimationFromPosition, startProgressAnimation } from './progress-ui.js';
import { startAudioHealthMonitoring, updateConnectionHealthUI } from './audio-manager.js';
import { getPlaylistNext, popPlaylistHead, playlistHasItems } from './playlist-tray.js';

// ====== Heartbeat & Sync System ======

export async function sendNextTrack(trackMd5 = null, direction = null, source = 'user') {
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
        state.heartbeatTimeout = null;
    }

    if (!state.streamFingerprint) {
        console.warn('⚠️ sendNextTrack: No fingerprint yet; waiting for SSE to bind');
        const ready = await waitForFingerprint(5000);

        if (!ready || !state.streamFingerprint) {
            console.warn('⚠️ sendNextTrack: Fingerprint still missing after wait; restarting session');
            await createNewJourneySession('missing_fingerprint');

            const fallbackReady = await waitForFingerprint(5000);
            if (!fallbackReady || !state.streamFingerprint) {
                console.error('❌ sendNextTrack: Aborting call - fingerprint unavailable');
                scheduleHeartbeat(10000);
                return;
            }
        }
    }

    const manualOverrideActive = state.manualNextTrackOverride && state.selectedIdentifier;
    const allowFallback = source !== 'manual_refresh';

    let md5ToSend = trackMd5;
    let dirToSend = direction;

    // First priority: Check playlist queue for pre-selected next track
    if (!md5ToSend && allowFallback && playlistHasItems()) {
        const queuedNext = getPlaylistNext();
        if (queuedNext) {
            md5ToSend = queuedNext.trackId;
            dirToSend = dirToSend || queuedNext.directionKey || null;
            console.log(`📤 sendNextTrack: Using queued track ${md5ToSend.substring(0,8)} from playlist`);
        }
    }

    if (!md5ToSend && allowFallback) {
        if (manualOverrideActive && state.selectedIdentifier) {
            md5ToSend = state.selectedIdentifier;
            dirToSend = dirToSend || state.manualNextDirectionKey || null;
        }

        if (!md5ToSend) {
            if (state.serverNextTrack) {
                md5ToSend = state.serverNextTrack;
                dirToSend = dirToSend || state.serverNextDirection || null;
            }
        }

        if (!md5ToSend) {
            md5ToSend = state.latestExplorerData?.nextTrack?.track?.identifier || null;
            dirToSend = dirToSend || state.latestExplorerData?.nextTrack?.directionKey || null;
        }

        if (!md5ToSend && state.lastRefreshSummary?.nextTrack) {
            const refreshNextId = extractNextTrackIdentifier(state.lastRefreshSummary.nextTrack);
            if (refreshNextId) {
                md5ToSend = refreshNextId;
                if (!dirToSend) {
                    dirToSend = extractNextTrackDirection(state.lastRefreshSummary.nextTrack);
                }
            }
        }

        if (!md5ToSend) {
            md5ToSend = state.selectedIdentifier || null;
        }

        if (!md5ToSend && state.previousNextTrack?.identifier) {
            md5ToSend = state.previousNextTrack.identifier;
            dirToSend = dirToSend || state.previousNextTrack.directionKey || null;
        }

        if (!md5ToSend) {
            const activeCard = document.querySelector('.dimension-card.next-track');
            if (activeCard) {
                const datasetMd5 = activeCard.dataset.trackMd5 || activeCard.dataset.trackIdentifier || null;
                if (datasetMd5) {
                    md5ToSend = datasetMd5;
                }
                if (!dirToSend) {
                    dirToSend = activeCard.dataset.directionKey || activeCard.dataset.baseDirectionKey || null;
                }
            }
        }

        if (!md5ToSend && state.baseDirectionKey) {
            const direction = state.latestExplorerData?.directions?.[state.baseDirectionKey] || null;
            const candidate = direction?.sampleTracks?.[0];
            if (candidate) {
                const track = candidate.track || candidate;
                if (track?.identifier) {
                    md5ToSend = track.identifier;
                    dirToSend = dirToSend || state.baseDirectionKey;
                }
            }
        }
    }

    if (manualOverrideActive && !dirToSend) {
        dirToSend = state.manualNextDirectionKey;
    }

    if (!md5ToSend) {
        console.warn('⚠️ sendNextTrack: No track MD5 available; requesting fresh guidance from server');
        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;

        if (source === 'heartbeat') {
            await requestSSERefresh();
            scheduleHeartbeat(30000);
        } else {
            await requestSSERefresh();
        }
        return;
    }

    console.log(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend || 'unknown'}`);

    if (source === 'user') {
        state.manualNextTrackOverride = true;
        state.manualNextDirectionKey = dirToSend;
        state.pendingManualTrackId = md5ToSend;
        if (state.nextTrackAnimationTimer) {
            clearTimeout(state.nextTrackAnimationTimer);
            state.nextTrackAnimationTimer = null;
        }
        if (state.cardsDormant) {
            if (typeof window.resolveNextTrackData === 'function') {
                const nextInfo = window.resolveNextTrackData();
                if (nextInfo?.track && typeof window.showNextTrackPreview === 'function') {
                    window.showNextTrackPreview(nextInfo.track);
                }
            }
        }
    }

    try {
        const response = await fetch('/next-track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                trackMd5: md5ToSend,
                direction: dirToSend,
                source,
                fingerprint: state.streamFingerprint,
                sessionId: state.sessionId
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        window.state = window.state || {};
        window.state.lastHeartbeatResponse = data;

        if (data.fingerprint) {
            if (state.streamFingerprint !== data.fingerprint) {
                console.log(`🔄 /next-track updated fingerprint to ${data.fingerprint}`);
            }
            applyFingerprint(data.fingerprint);
        }

        if (source === 'user' && md5ToSend) {
            state.selectedIdentifier = md5ToSend;
        }

        const serverTrack = data.currentTrack;
        const localTrack = state.latestCurrentTrack?.identifier || null;
        if (source === 'heartbeat' && serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch (immediate)', { serverTrack, localTrack });
            fullResync();
            return;
        }

        if (DEBUG_FLAGS.deck) {
            console.log(`📥 Server response: next=${data.nextTrack?.substring(0,8)}, current=${data.currentTrack?.substring(0,8)}, remaining=${data.remaining}ms`);
        }

        analyzeAndAct(data, source, md5ToSend);

    } catch (error) {
        console.error('❌ sendNextTrack failed:', error);
        scheduleHeartbeat(10000);
    }
}

function analyzeAndAct(data, source, sentMd5) {
    const { nextTrack, currentTrack, duration, remaining } = data;

    if (data.fingerprint && state.streamFingerprint !== data.fingerprint) {
        if (!DEBUG_FLAGS.deck) {
            console.log(`🔄 Server response rotated fingerprint to ${data.fingerprint.substring(0, 6)}…`);
        }
        applyFingerprint(data.fingerprint);
    }

    if (!data || !currentTrack) {
        console.warn('⚠️ Invalid server response');
        scheduleHeartbeat(60000);
        return;
    }

    const ICON = '🛰️';
    const serverDurationSeconds = (typeof duration === 'number' && duration > 0) ? (duration / 1000) : null;
    const serverElapsedSeconds = (typeof duration === 'number' && typeof remaining === 'number' && duration > 0)
        ? Math.max((duration - remaining) / 1000, 0)
        : null;
    const clientDurationSeconds = state.playbackDurationSeconds || null;
    const clientElapsedSeconds = (state.playbackStartTimestamp && state.playbackDurationSeconds)
        ? Math.max((Date.now() - state.playbackStartTimestamp) / 1000, 0)
        : null;

    const clientNextTrack = state.latestExplorerData?.nextTrack?.track?.identifier
        || state.latestExplorerData?.nextTrack?.identifier
        || state.selectedIdentifier
        || null;

    if (DEBUG_FLAGS.deck) {
        console.log(`${ICON} Sync snapshot (${source})`, {
            server: {
                currentTrack: currentTrack || null,
                elapsedSeconds: serverElapsedSeconds,
                durationSeconds: serverDurationSeconds,
                nextTrack: nextTrack || null
            },
            client: {
                currentTrack: state.latestCurrentTrack?.identifier || null,
                elapsedSeconds: clientElapsedSeconds,
                durationSeconds: clientDurationSeconds,
                nextTrack: clientNextTrack || null,
                pendingSelection: state.selectedIdentifier || null
            },
            sentOverride: sentMd5 || null
        });
    }

    const currentMd5 = state.latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        console.log(`${ICON} ACTION current-track-mismatch`, {
            expected: currentMd5,
            received: currentTrack,
            source
        });
        fullResync();
        return;
    }

    const expectedNextMd5 = state.latestExplorerData?.nextTrack?.track?.identifier || state.selectedIdentifier;
    const hasServerNext = Boolean(nextTrack);
    const nextTrackMismatch = Boolean(expectedNextMd5 && hasServerNext && nextTrack !== expectedNextMd5);

    if (expectedNextMd5 && !hasServerNext) {
        console.log(`${ICON} ACTION awaiting-server-next`, {
            expected: expectedNextMd5,
            source,
            sentMd5
        });
        if (state.manualNextTrackOverride) {
            scheduleHeartbeat(10000);
        }
    }

    if (nextTrackMismatch) {
        if (state.manualNextTrackOverride || state.pendingManualTrackId) {
            console.log(`${ICON} ACTION server-next-ignored`, {
                expected: expectedNextMd5,
                received: nextTrack,
                source,
                overrideActive: state.manualNextTrackOverride,
                pendingManualTrackId: state.pendingManualTrackId,
                sentMd5
            });
            scheduleHeartbeat(20000);
            return;
        }

        console.log(`${ICON} ACTION next-track-mismatch`, {
            expected: expectedNextMd5,
            received: nextTrack,
            source,
            sentMd5
        });

        if (sentMd5 && nextTrack === sentMd5) {
            console.log(`${ICON} ACTION confirmation`, {
                acknowledged: sentMd5,
                source
            });
            scheduleHeartbeat(60000);
            return;
        }

        if (isTrackInNeighborhood(nextTrack)) {
            console.log(`${ICON} ACTION promote-neighborhood`, {
                track: nextTrack,
                source
            });
            promoteTrackToNextStack(nextTrack);
            scheduleHeartbeat(60000);
        } else {
            console.log(`${ICON} ACTION full-resync-needed`, {
                track: nextTrack,
                reason: 'not_in_neighborhood',
                source
            });
            fullResync();
            return;
        }
    }

    if (typeof duration === 'number' && typeof remaining === 'number' && duration > 0) {
        const durationSeconds = Math.max(duration / 1000, 0);
        const elapsedSeconds = Math.max((duration - remaining) / 1000, 0);
        const clampedElapsed = Math.min(elapsedSeconds, durationSeconds);
        console.log(`${ICON} ACTION timing-update`, {
            durationSeconds,
            elapsedSeconds: clampedElapsed,
            source
        });
        if (typeof window.startProgressAnimationFromPosition === 'function') {
            startProgressAnimationFromPosition(durationSeconds, clampedElapsed, { resync: true });
        }
    }

    console.log(`${ICON} ACTION sync-ok`, { source });

    if (state.cardsDormant) {
        if (typeof window.resolveNextTrackData === 'function') {
            const info = window.resolveNextTrackData();
            if (info?.track && typeof window.showNextTrackPreview === 'function') {
                window.showNextTrackPreview(info.track);
            }
        }
    }

    scheduleHeartbeat(60000);
}

function isTrackInNeighborhood(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        return false;
    }

    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const found = direction.sampleTracks.some(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });
            if (found) {
                console.log(`🔍 Track ${trackMd5.substring(0,8)} found in direction: ${dirKey}`);
                return true;
            }
        }
    }

    return false;
}

function promoteTrackToNextStack(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        console.warn('⚠️ No explorer data to promote track from');
        return;
    }

    let foundDirection = null;
    let foundTrack = null;

    for (const [dirKey, direction] of Object.entries(state.latestExplorerData.directions)) {
        if (direction.sampleTracks) {
            const trackData = direction.sampleTracks.find(sample => {
                const track = sample.track || sample;
                return track.identifier === trackMd5;
            });

            if (trackData) {
                foundDirection = dirKey;
                foundTrack = trackData.track || trackData;
                break;
            }
        }
    }

    if (!foundDirection || !foundTrack) {
        console.error('❌ Track not found in any direction, cannot promote');
        return;
    }

    console.log(`🎯 Promoting track from ${foundDirection} to next track stack`);

    if (typeof window.swapNextTrackDirection === 'function') {
        window.swapNextTrackDirection(foundDirection);
    }

    state.selectedIdentifier = trackMd5;
}

export function scheduleHeartbeat(delayMs = 60000) {
    const MIN_HEARTBEAT_INTERVAL = 1000;
    delayMs = Math.max(delayMs, MIN_HEARTBEAT_INTERVAL);
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
    }

    state.heartbeatTimeout = setTimeout(() => {
        console.log('💓 Heartbeat triggered');
        sendNextTrack(null, null, 'heartbeat');
        window.state = window.state || {};
        const serverTrack = window.state?.lastHeartbeatResponse?.currentTrack;
        const localTrack = window.state?.latestCurrentTrack?.identifier || null;
        if (serverTrack && localTrack && serverTrack !== localTrack) {
            console.error('🛰️ ACTION heartbeat-track-mismatch', { serverTrack, localTrack });
            fullResync();
            return;
        }

    }, delayMs);

    console.log(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

export async function fullResync() {
    console.log('🔄 Full resync triggered - calling /refresh-sse');

    try {
        const payload = {};
        if (state.streamFingerprint) {
            payload.fingerprint = state.streamFingerprint;
        }
        if (state.sessionId) {
            payload.sessionId = state.sessionId;
        }

        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.status === 404) {
            console.error('🚨 Session not found on server - session was destroyed (likely server restart)');
            console.log('🔄 Reloading page to get new session...');
            window.location.reload();
            return;
        }

        const result = await response.json();

        if (result.fingerprint) {
            if (state.streamFingerprint !== result.fingerprint) {
                console.log(`🔄 Resync payload updated fingerprint to ${result.fingerprint}`);
            }
            applyFingerprint(result.fingerprint);
        }

        if (result.ok) {
            console.log('✅ Resync broadcast triggered, waiting for SSE update...');
            scheduleHeartbeat(60000);

            if (state.pendingResyncCheckTimer) {
              clearTimeout(state.pendingResyncCheckTimer);
            }

            state.pendingResyncCheckTimer = setTimeout(() => {
              const lastUpdate = state.lastTrackUpdateTs || 0;
              const age = Date.now() - lastUpdate;
              const hasCurrent = state.latestCurrentTrack && state.latestCurrentTrack.identifier;

              if (!hasCurrent || age > 5000) {
                console.warn('🛰️ ACTION resync-followup: no track update after broadcast, requesting SSE refresh');
                requestSSERefresh();
              }
            }, 5000);
        } else {
            console.warn('⚠️ Resync failed:', result.reason);

            if (result.error === 'Session not found' || result.error === 'Master session not found') {
                console.log('🔄 Session lost, reloading page...');
                window.location.reload();
                return;
            }

            scheduleHeartbeat(10000);
        }
    } catch (error) {
        console.error('❌ Resync error:', error);
        scheduleHeartbeat(10000);
    }
}

export async function createNewJourneySession(reason = 'unknown') {
    if (state.creatingNewSession) {
        console.log(`🛰️ ACTION new-session-skip: already creating (${reason})`);
        return;
    }

    state.creatingNewSession = true;
    try {
        console.warn(`🛰️ ACTION new-session (${reason}) - requesting fresh journey`);

        const streamElement = state.isStarted ? elements.audio : null;
        if (streamElement) {
            try {
                streamElement.pause();
            } catch (err) {
                console.warn('🎵 Pause before new session failed:', err);
            }
        }

        clearFingerprint({ reason: `new_session_${reason}` });
        state.sessionId = null;

        const newStreamUrl = composeStreamEndpoint(null, Date.now());
        state.streamUrl = newStreamUrl;
        window.streamUrl = newStreamUrl;

        if (streamElement) {
            audioHealth.isHealthy = false;
            audioHealth.lastTimeUpdate = null;
            audioHealth.bufferingStarted = Date.now();
            streamElement.src = newStreamUrl;
            streamElement.load();
            state.awaitingSSE = true;
        }

        state.manualNextTrackOverride = false;
        state.manualNextDirectionKey = null;
        state.pendingManualTrackId = null;
        state.selectedIdentifier = null;
        state.stackIndex = 0;
        state.latestExplorerData = null;
        state.remainingCounts = {};
        state.pendingExplorerSnapshot = null;
        if (state.pendingExplorerTimer) {
            clearTimeout(state.pendingExplorerTimer);
            state.pendingExplorerTimer = null;
        }
        state.pendingExplorerNext = null;

        clearPendingExplorerLookahead({ reason: 'session-reset' });
        setDeckStaleFlag(false, { reason: 'session-reset' });
        exitDangerZoneVisualState({ reason: 'session-reset' });

        if (state.pendingInitialTrackTimer) {
            clearTimeout(state.pendingInitialTrackTimer);
            state.pendingInitialTrackTimer = null;
        }
        if (state.pendingResyncCheckTimer) {
            clearTimeout(state.pendingResyncCheckTimer);
            state.pendingResyncCheckTimer = null;
        }

        if (connectionHealth.currentEventSource) {
            connectionHealth.currentEventSource.close();
            connectionHealth.currentEventSource = null;
        }
        connectionHealth.sse.status = 'reconnecting';

        if (typeof window.updateConnectionHealthUI === 'function') {
            updateConnectionHealthUI();
        }

        setTimeout(() => {
            if (typeof window.connectSSE === 'function') {
                window.connectSSE();
            }
        }, 200);

        if (streamElement && state.isStarted) {
            if (typeof window.startAudioHealthMonitoring === 'function') {
                startAudioHealthMonitoring();
            }
            streamElement.play().catch(err => {
                console.error('🎵 Audio play failed after new session:', err);
            });
        }

        scheduleHeartbeat(5000);
    } catch (error) {
        console.error('❌ Failed to create new journey session:', error);
        scheduleHeartbeat(10000);
    } finally {
        state.creatingNewSession = false;
    }
}

export async function verifyExistingSessionOrRestart(reason = 'unknown', options = {}) {
    const { escalate = true } = options;
    if (!state.streamFingerprint) {
        const ready = await waitForFingerprint(3000);
        if (!ready || !state.streamFingerprint) {
            if (escalate) {
                await createNewJourneySession(reason);
            }
            return false;
        }
    }

    try {
        const ok = await requestSSERefresh({ escalate: false });
        if (ok) {
            console.warn('🛰️ ACTION session-rebind: stream still active, reconnecting SSE without resetting');

            if (connectionHealth.currentEventSource) {
                connectionHealth.currentEventSource.close();
                connectionHealth.currentEventSource = null;
            }

            connectionHealth.sse.status = 'reconnecting';
            if (typeof window.updateConnectionHealthUI === 'function') {
                updateConnectionHealthUI();
            }
            if (typeof window.connectSSE === 'function') {
                window.connectSSE();
            }

            scheduleHeartbeat(10000);
            return true;
        }
    } catch (error) {
        console.error('❌ verifyExistingSessionOrRestart failed:', error);
    }

    if (escalate) {
        await createNewJourneySession(reason);
    }
    return false;
}

export async function requestSSERefresh(options = {}) {
    const { escalate = true, stage = 'rebroadcast' } = options;
    if (!state.streamFingerprint) {
        console.warn('⚠️ requestSSERefresh: No fingerprint yet; waiting for SSE handshake');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            console.warn('⚠️ requestSSERefresh: Aborting refresh - fingerprint unavailable');
            return false;
        }
    }

    try {
        console.log('🔄 Sending SSE refresh request to backend...');
        const requestBody = {
            reason: 'zombie_session_recovery',
            clientTime: Date.now(),
            lastTrackStart: state.latestCurrentTrack?.startTime || null,
            fingerprint: state.streamFingerprint,
            sessionId: state.sessionId,
            stage
        };

        // Always request fresh explorer data on manual refresh
        requestBody.requestExplorerData = true;
        requestBody.forceExplorerRefresh = true;

        const response = await fetch('/refresh-sse', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        if (response.ok) {
            const result = await response.json();
            console.log('✅ SSE refresh request successful:', result);

            state.lastRefreshSummary = result;

            if (result.fingerprint) {
                if (state.streamFingerprint !== result.fingerprint) {
                    console.log(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
                }
                applyFingerprint(result.fingerprint);
            }

            if (result.ok === false) {
                const reason = result.reason || 'unknown';
                console.warn(`🔄 SSE refresh reported issue: ${reason}`);

                if (reason === 'inactive') {
                    console.warn('🔄 SSE refresh indicates inactive session; verifying stream state');
                    if (!escalate) {
                        return false;
                    }
                    if (result.streamAlive === false) {
                        await createNewJourneySession('refresh_inactive');
                    } else {
                        await verifyExistingSessionOrRestart('refresh_inactive');
                    }
                } else if (reason === 'no_track') {
                    state.noTrackRefreshCount = (state.noTrackRefreshCount || 0) + 1;
                    console.warn('🔄 SSE refresh returned no track', {
                        attempt: state.noTrackRefreshCount,
                        escalate
                    });
                    if (state.noTrackRefreshCount >= 3 && escalate) {
                        console.warn('🛰️ No-track loop detected; creating new journey session');
                        await createNewJourneySession('refresh_no_track_loop');
                    } else if (state.noTrackRefreshCount >= 2 && escalate) {
                        console.warn('🛰️ Rebinding session after repeated no-track responses');
                        const rebound = await verifyExistingSessionOrRestart('refresh_no_track', { escalate: false });
                        if (!rebound) {
                            await createNewJourneySession('refresh_no_track_rebind_failed');
                        }
                    } else {
                        console.warn('🔄 Scheduling quick heartbeat to re-request explorer snapshot');
                        scheduleHeartbeat(5000);
                    }
                }
                return false;
            }

            state.noTrackRefreshCount = 0;
            if (result.currentTrack) {
                console.log(`🔄 Backend reports active session with track: ${result.currentTrack.title} by ${result.currentTrack.artist}`);
                console.log(`🔄 Duration: ${result.currentTrack.duration}s, Broadcasting to ${result.clientCount} clients`);

                if (result.fingerprint && state.streamFingerprint !== result.fingerprint) {
                    console.log(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
                    applyFingerprint(result.fingerprint);
                }

                if (typeof window.updateNowPlayingCard === 'function') {
                    window.updateNowPlayingCard(result.currentTrack, null);
                }

                if (result.nextTrack) {
                    const nextTrackId = extractNextTrackIdentifier(result.nextTrack);
                    if (nextTrackId) {
                        state.serverNextTrack = nextTrackId;
                        const nextDirection = extractNextTrackDirection(result.nextTrack);
                        if (nextDirection) {
                            state.serverNextDirection = nextDirection;
                        }
                        if (!state.manualNextTrackOverride) {
                            state.selectedIdentifier = state.selectedIdentifier || nextTrackId;
                        }
                    } else {
                        console.warn('⚠️ SSE refresh nextTrack present but missing identifier', result.nextTrack);
                    }
                }

                if (result.explorerData) {
                    console.log(`🔄 Backend provided exploration data, updating direction cards`);
                    if (typeof window.createDimensionCards === 'function') {
                        window.createDimensionCards(result.explorerData);
                    }
                } else {
                    console.log(`🔄 No exploration data from backend - keeping existing cards`);
                }

                if (!result.explorerData && (!state.latestExplorerData || !state.latestExplorerData.directions)) {
                    console.warn('⚠️ Explorer data still missing after refresh; forcing follow-up request');
                    fullResync();
                }

                if (result.currentTrack.duration) {
                    if (typeof window.startProgressAnimation === 'function') {
                        startProgressAnimation(result.currentTrack.duration);
                    }
                }

            } else {
                console.warn('🔄 SSE refresh completed but no current track reported');
            }

            return true;

        } else {
            console.error('❌ SSE refresh request failed:', response.status, response.statusText);
            const errorText = await response.text();
            console.error('❌ Error details:', errorText);
        }

    } catch (error) {
        console.error('❌ SSE refresh request error:', error);
    }

    return false;
}

export async function manualRefresh() {
    console.log('🔄 Manual refresh requested');

    // First, try to fetch fresh explorer data for current track
    const currentTrackId = state.latestCurrentTrack?.identifier;
    if (currentTrackId) {
        console.log('🔄 Fetching fresh explorer data for current track');
        const { fetchExplorerWithPlaylist } = await import('./explorer-fetch.js');
        const explorerData = await fetchExplorerWithPlaylist(currentTrackId, { forceFresh: true });
        if (explorerData && Object.keys(explorerData.directions || {}).length > 0) {
            console.log('🔄 Explorer data refreshed successfully');
            state.latestExplorerData = explorerData;
            if (typeof window.createDimensionCards === 'function') {
                window.createDimensionCards(explorerData, { skipExitAnimation: false, forceRedraw: true });
            }
            return 'explorer_refresh';
        }
        console.warn('🔄 Explorer refresh returned no directions');
    }

    if (!state.streamFingerprint) {
        console.warn('🛰️ Manual refresh: no fingerprint yet; waiting before attempting rebroadcast');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            console.warn('🛰️ Manual refresh: fingerprint still missing; escalating to new session');
            await createNewJourneySession('manual_refresh_stage3_no_fingerprint');
            return 'new_session';
        }
    }

    const rebroadcastOk = await requestSSERefresh({ escalate: false, stage: 'rebroadcast' });
    if (rebroadcastOk) {
        console.log('🔄 Manual refresh: heartbeat rebroadcast succeeded');
        return 'rebroadcast';
    }

    console.warn('🛰️ Manual refresh: rebroadcast did not recover; attempting session rebind');
    const rebindOk = await verifyExistingSessionOrRestart('manual_refresh_stage2', { escalate: false });
    if (rebindOk) {
        console.log('🔄 Manual refresh: session rebind succeeded');
        return 'session_rebind';
    }

    console.warn('🛰️ Manual refresh: session rebind failed; creating new journey session');
    await createNewJourneySession('manual_refresh_stage3');
    return 'new_session';
}

export function setupManualRefreshButton() {
    const refreshButton = document.getElementById('refreshButton');

    if (!refreshButton) {
        console.warn('🔄 Manual refresh button not found in DOM');
        return;
    }

    refreshButton.addEventListener('click', async () => {
        console.log('🔄 Manual refresh button clicked');
        refreshButton.classList.add('refreshing');

        try {
            const outcome = await manualRefresh();
            console.log(`🔄 Manual refresh completed via ${outcome}`);
            setTimeout(() => refreshButton.classList.remove('refreshing'), 1200);
        } catch (error) {
            console.error('❌ Manual refresh failed:', error);
            refreshButton.classList.remove('refreshing');
        }
    });

    const hardResetButton = document.getElementById('hardResetButton');
    if (hardResetButton) {
        hardResetButton.addEventListener('click', async () => {
            console.warn('🛑 Hard reset requested by user');
            hardResetButton.classList.add('refreshing');
            try {
                await createNewJourneySession('manual_hard_reset');
            } catch (error) {
                console.error('❌ Hard reset failed:', error);
            } finally {
                setTimeout(() => hardResetButton.classList.remove('refreshing'), 1500);
            }
        });
    }

    console.log('🔄 Manual refresh button set up');
}

// Expose globally for backward compatibility and console debugging
window.sendNextTrack = sendNextTrack;
window.scheduleHeartbeat = scheduleHeartbeat;
window.fullResync = fullResync;
window.createNewJourneySession = createNewJourneySession;
window.verifyExistingSessionOrRestart = verifyExistingSessionOrRestart;
window.requestSSERefresh = requestSSERefresh;
window.manualRefresh = manualRefresh;
window.setupManualRefreshButton = setupManualRefreshButton;
