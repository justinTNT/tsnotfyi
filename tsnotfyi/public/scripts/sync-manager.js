// Sync manager - heartbeat, server communication, session recovery
import { state, elements, audioHealth, connectionHealth } from './globals.js';
import { createLogger } from './log.js';
import { applyFingerprint, clearFingerprint, waitForFingerprint, composeStreamEndpoint } from './session-utils.js';
import { setDeckStaleFlag } from './deck-state.js';
import { extractNextTrackIdentifier, extractNextTrackDirection } from './explorer-utils.js';
import { startProgressAnimationFromPosition, startProgressAnimation } from './progress-ui.js';
import { startAudioHealthMonitoring, updateConnectionHealthUI, getBufferDelaySecs } from './audio-manager.js';
import { getPlaylistNext, popPlaylistHead, playlistHasItems } from './playlist-tray.js';
import { setSelection, clearSelection, isUserSelection } from './selection.js';

const log = createLogger('sync');
const overrideLog = createLogger('override');

// ====== Heartbeat & Sync System ======

export async function sendNextTrack(trackMd5 = null, direction = null, source = 'user') {
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
        state.heartbeatTimeout = null;
    }

    if (!state.streamFingerprint) {
        log.warn('⚠️ sendNextTrack: No fingerprint yet; waiting for SSE to bind');
        const ready = await waitForFingerprint(5000);

        if (!ready || !state.streamFingerprint) {
            log.warn('⚠️ sendNextTrack: Fingerprint still missing after wait; restarting session');
            await createNewJourneySession('missing_fingerprint');

            const fallbackReady = await waitForFingerprint(5000);
            if (!fallbackReady || !state.streamFingerprint) {
                log.error('❌ sendNextTrack: Aborting call - fingerprint unavailable');
                scheduleHeartbeat(10000);
                return;
            }
        }
    }

    const manualOverrideActive = isUserSelection() && state.selection.trackId;
    const allowFallback = source !== 'manual_refresh';

    let md5ToSend = trackMd5;
    let dirToSend = direction;

    // First priority: Check playlist queue for pre-selected next track
    if (!md5ToSend && allowFallback && playlistHasItems()) {
        const queuedNext = getPlaylistNext();
        if (queuedNext) {
            md5ToSend = queuedNext.trackId;
            dirToSend = dirToSend || queuedNext.directionKey || null;
            // Playlist picks must reach the server as 'user' so it actually prepares them.
            // Heartbeat source is read-only on the server — it logs mismatches but never acts.
            if (source !== 'user') {
                source = 'user';
                log.info(`📤 sendNextTrack: Using queued track ${md5ToSend.substring(0,8)} from playlist (promoted to user source)`);
            } else {
                log.info(`📤 sendNextTrack: Using queued track ${md5ToSend.substring(0,8)} from playlist`);
            }
        }
    }

    if (!md5ToSend && allowFallback) {
        if (manualOverrideActive && state.selection.trackId) {
            md5ToSend = state.selection.trackId;
            dirToSend = dirToSend || state.selection.directionKey || null;
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
            md5ToSend = state.selection.trackId || null;
        }

        if (!md5ToSend && state.previousNextTrack?.identifier) {
            md5ToSend = state.previousNextTrack.identifier;
            dirToSend = dirToSend || state.previousNextTrack.directionKey || null;
        }

        if (!md5ToSend) {
            const nextEntry = state.latestExplorerData?.nextTrack;
            const nextObj = nextEntry?.track || nextEntry;
            if (nextObj?.identifier) {
                md5ToSend = nextObj.identifier;
                dirToSend = dirToSend || nextEntry?.directionKey || null;
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
        dirToSend = state.selection.directionKey;
    }

    if (!md5ToSend) {
        log.warn('⚠️ sendNextTrack: No track MD5 available; requesting fresh guidance from server');
        clearSelection('error');
        state.stackIndex = 0;

        if (source === 'heartbeat') {
            await requestSSERefresh();
            scheduleHeartbeat(30000);
        } else {
            await requestSSERefresh();
        }
        return;
    }

    log.info(`📤 sendNextTrack (${source}): ${md5ToSend.substring(0,8)}... via ${dirToSend || 'unknown'}`);

    if (source === 'user') {
        setSelection(md5ToSend, 'user', dirToSend);
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
                sessionId: state.sessionId,
                clientBufferSecs: getBufferDelaySecs()
            })
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        window.state = window.state || {};
        window.state.lastHeartbeatResponse = data;

        if (data.fingerprint) {
            if (state.streamFingerprint !== data.fingerprint) {
                log.info(`🔄 /next-track updated fingerprint to ${data.fingerprint}`);
            }
            applyFingerprint(data.fingerprint);
        }

        if (source === 'user' && md5ToSend) {
            setSelection(md5ToSend, 'user');
        }

        const serverTrack = data.currentTrack;
        const localTrack = state.latestCurrentTrack?.identifier || null;
        if (source === 'heartbeat' && serverTrack && localTrack && serverTrack !== localTrack) {
            overrideLog.error('🛰️ ACTION heartbeat-track-mismatch (immediate)', { serverTrack, localTrack });
            fullResync();
            return;
        }

        log.debug(`📥 Server response: next=${data.nextTrack?.substring(0,8)}, current=${data.currentTrack?.substring(0,8)}, remaining=${data.remaining}ms`);

        analyzeAndAct(data, source, md5ToSend);

    } catch (error) {
        log.error('❌ sendNextTrack failed:', error);
        scheduleHeartbeat(10000);
    }
}

function analyzeAndAct(data, source, sentMd5) {
    const { nextTrack, currentTrack, duration, remaining } = data;

    if (data.fingerprint && state.streamFingerprint !== data.fingerprint) {
        log.debug(`🔄 Server response rotated fingerprint to ${data.fingerprint.substring(0, 6)}…`);
        applyFingerprint(data.fingerprint);
    }

    if (!data || !currentTrack) {
        log.warn('⚠️ Invalid server response');
        scheduleHeartbeat(90000);
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
        || state.selection.trackId
        || null;

    overrideLog.debug(`${ICON} Sync snapshot (${source})`, {
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
            pendingSelection: state.selection.trackId || null
        },
        sentOverride: sentMd5 || null
    });

    const currentMd5 = state.latestCurrentTrack?.identifier;
    const currentTrackMismatch = currentMd5 && currentTrack !== currentMd5;

    if (currentTrackMismatch) {
        overrideLog.info(`${ICON} ACTION current-track-mismatch`, {
            expected: currentMd5,
            received: currentTrack,
            source
        });
        fullResync();
        return;
    }

    const expectedNextMd5 = state.latestExplorerData?.nextTrack?.track?.identifier || state.selection.trackId;
    const hasServerNext = Boolean(nextTrack);
    const nextTrackMismatch = Boolean(expectedNextMd5 && hasServerNext && nextTrack !== expectedNextMd5);

    if (expectedNextMd5 && !hasServerNext) {
        overrideLog.info(`${ICON} ACTION awaiting-server-next`, {
            expected: expectedNextMd5,
            source,
            sentMd5
        });
        if (isUserSelection()) {
            scheduleHeartbeat(10000);
        }
    }

    if (nextTrackMismatch) {
        if (isUserSelection() || state.selection.pendingTrackId) {
            overrideLog.info(`${ICON} ACTION server-next-ignored`, {
                expected: expectedNextMd5,
                received: nextTrack,
                source,
                overrideActive: isUserSelection(),
                pendingManualTrackId: state.selection.pendingTrackId,
                sentMd5
            });
            scheduleHeartbeat(20000);
            return;
        }

        overrideLog.info(`${ICON} ACTION next-track-mismatch`, {
            expected: expectedNextMd5,
            received: nextTrack,
            source,
            sentMd5
        });

        if (sentMd5 && nextTrack === sentMd5) {
            overrideLog.info(`${ICON} ACTION confirmation`, {
                acknowledged: sentMd5,
                source
            });
            scheduleHeartbeat(90000);
            return;
        }

        if (isTrackInNeighborhood(nextTrack)) {
            overrideLog.info(`${ICON} ACTION promote-neighborhood`, {
                track: nextTrack,
                source
            });
            promoteTrackToNextStack(nextTrack);
            scheduleHeartbeat(90000);
        } else {
            overrideLog.info(`${ICON} ACTION full-resync-needed`, {
                track: nextTrack,
                reason: 'not_in_neighborhood',
                source
            });
            fullResync();
            return;
        }
    }

    // Server timing intentionally NOT used here - audio.currentTime drives the display
    // Using server elapsed would cause desync when client joins mid-stream
    // (server knows where playhead is, but audio stream starts from current position)

    overrideLog.info(`${ICON} ACTION sync-ok`, { source });

    if (state.cardsDormant) {
        if (typeof window.resolveNextTrackData === 'function') {
            const info = window.resolveNextTrackData();
            if (info?.track && typeof window.showNextTrackPreview === 'function') {
                window.showNextTrackPreview(info.track);
            }
        }
    }

    scheduleHeartbeat(90000);
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
                log.info(`🔍 Track ${trackMd5.substring(0,8)} found in direction: ${dirKey}`);
                return true;
            }
        }
    }

    return false;
}

function promoteTrackToNextStack(trackMd5) {
    if (!state.latestExplorerData || !state.latestExplorerData.directions) {
        log.warn('⚠️ No explorer data to promote track from');
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
        log.error('❌ Track not found in any direction, cannot promote');
        return;
    }

    log.info(`🎯 Promoting track from ${foundDirection} to next track stack`);

    if (typeof window.swapNextTrackDirection === 'function') {
        window.swapNextTrackDirection(foundDirection);
    }

    setSelection(trackMd5, 'user');
}

export function scheduleHeartbeat(delayMs = 60000) {
    const MIN_HEARTBEAT_INTERVAL = 1000;
    delayMs = Math.max(delayMs, MIN_HEARTBEAT_INTERVAL);
    if (state.heartbeatTimeout) {
        clearTimeout(state.heartbeatTimeout);
    }

    state.heartbeatTimeout = setTimeout(() => {
        log.debug('💓 Heartbeat triggered');
        sendNextTrack(null, null, 'heartbeat');
        window.state = window.state || {};
        const serverTrack = window.state?.lastHeartbeatResponse?.currentTrack;
        const localTrack = window.state?.latestCurrentTrack?.identifier || null;
        if (serverTrack && localTrack && serverTrack !== localTrack) {
            overrideLog.error('🛰️ ACTION heartbeat-track-mismatch', { serverTrack, localTrack });
            fullResync();
            return;
        }

    }, delayMs);

    log.debug(`💓 Heartbeat scheduled in ${delayMs/1000}s`);
}

export async function fullResync() {
    log.info('🔄 Full resync triggered - calling /refresh-sse');

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
            log.error('🚨 Session not found on server - session was destroyed (likely server restart)');
            log.info('🔄 Reloading page to get new session...');
            window.location.reload();
            return;
        }

        const result = await response.json();

        if (result.fingerprint) {
            if (state.streamFingerprint !== result.fingerprint) {
                log.info(`🔄 Resync payload updated fingerprint to ${result.fingerprint}`);
            }
            applyFingerprint(result.fingerprint);
        }

        if (result.ok) {
            log.info('✅ Resync broadcast triggered, waiting for SSE update...');
            scheduleHeartbeat(90000);

            if (state.pendingResyncCheckTimer) {
              clearTimeout(state.pendingResyncCheckTimer);
            }

            state.pendingResyncCheckTimer = setTimeout(() => {
              const lastUpdate = state.lastTrackUpdateTs || 0;
              const age = Date.now() - lastUpdate;
              const hasCurrent = state.latestCurrentTrack && state.latestCurrentTrack.identifier;

              if (!hasCurrent || age > 5000) {
                overrideLog.warn('🛰️ ACTION resync-followup: no track update after broadcast, requesting SSE refresh');
                requestSSERefresh();
              }
            }, 5000);
        } else {
            log.warn('⚠️ Resync failed:', result.reason);

            if (result.error === 'Session not found' || result.error === 'Master session not found') {
                log.info('🔄 Session lost, reloading page...');
                window.location.reload();
                return;
            }

            scheduleHeartbeat(10000);
        }
    } catch (error) {
        log.error('❌ Resync error:', error);
        scheduleHeartbeat(10000);
    }
}

export async function createNewJourneySession(reason = 'unknown') {
    if (state.creatingNewSession) {
        overrideLog.info(`🛰️ ACTION new-session-skip: already creating (${reason})`);
        return;
    }

    state.creatingNewSession = true;
    try {
        overrideLog.warn(`🛰️ ACTION new-session (${reason}) - requesting fresh journey`);

        const streamElement = state.isStarted ? elements.audio : null;
        if (streamElement) {
            try {
                streamElement.pause();
            } catch (err) {
                log.warn('🎵 Pause before new session failed:', err);
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

        clearSelection('error');
        state.stackIndex = 0;
        state.latestExplorerData = null;
        state.remainingCounts = {};
        state.pendingExplorerSnapshot = null;
        if (state.pendingExplorerTimer) {
            clearTimeout(state.pendingExplorerTimer);
            state.pendingExplorerTimer = null;
        }
        state.pendingExplorerNext = null;

        setDeckStaleFlag(false, { reason: 'session-reset' });

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
                log.error('🎵 Audio play failed after new session:', err);
            });
        }

        scheduleHeartbeat(5000);
    } catch (error) {
        log.error('❌ Failed to create new journey session:', error);
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
            overrideLog.warn('🛰️ ACTION session-rebind: stream still active, reconnecting SSE without resetting');

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
        log.error('❌ verifyExistingSessionOrRestart failed:', error);
    }

    if (escalate) {
        await createNewJourneySession(reason);
    }
    return false;
}

export async function requestSSERefresh(options = {}) {
    const { escalate = true, stage = 'rebroadcast' } = options;
    if (!state.streamFingerprint) {
        log.warn('⚠️ requestSSERefresh: No fingerprint yet; waiting for SSE handshake');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            log.warn('⚠️ requestSSERefresh: Aborting refresh - fingerprint unavailable');
            return false;
        }
    }

    try {
        log.info('🔄 Sending SSE refresh request to backend...');
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
            log.info('✅ SSE refresh request successful:', result);

            state.lastRefreshSummary = result;

            if (result.fingerprint) {
                if (state.streamFingerprint !== result.fingerprint) {
                    log.info(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
                }
                applyFingerprint(result.fingerprint);
            }

            if (result.ok === false) {
                const reason = result.reason || 'unknown';
                log.warn(`🔄 SSE refresh reported issue: ${reason}`);

                if (reason === 'inactive') {
                    log.warn('🔄 SSE refresh indicates inactive session; verifying stream state');
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
                    log.warn('🔄 SSE refresh returned no track', {
                        attempt: state.noTrackRefreshCount,
                        escalate
                    });
                    if (state.noTrackRefreshCount >= 3 && escalate) {
                        overrideLog.warn('🛰️ No-track loop detected; creating new journey session');
                        await createNewJourneySession('refresh_no_track_loop');
                    } else if (state.noTrackRefreshCount >= 2 && escalate) {
                        overrideLog.warn('🛰️ Rebinding session after repeated no-track responses');
                        const rebound = await verifyExistingSessionOrRestart('refresh_no_track', { escalate: false });
                        if (!rebound) {
                            await createNewJourneySession('refresh_no_track_rebind_failed');
                        }
                    } else {
                        log.warn('🔄 Scheduling quick heartbeat to re-request explorer snapshot');
                        scheduleHeartbeat(5000);
                    }
                }
                return false;
            }

            state.noTrackRefreshCount = 0;
            if (result.currentTrack) {
                log.info(`🔄 Backend reports active session with track: ${result.currentTrack.title} by ${result.currentTrack.artist}`);
                log.info(`🔄 Duration: ${result.currentTrack.duration}s, Broadcasting to ${result.clientCount} clients`);

                if (result.fingerprint && state.streamFingerprint !== result.fingerprint) {
                    log.info(`🔄 SSE refresh updated fingerprint to ${result.fingerprint}`);
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
                        if (!isUserSelection() && !state.selection.trackId) {
                            setSelection(nextTrackId, 'server');
                        }
                    } else {
                        log.warn('⚠️ SSE refresh nextTrack present but missing identifier', result.nextTrack);
                    }
                }

                if (result.explorerData) {
                    log.info(`🔄 Backend provided exploration data, updating direction cards`);
                    if (typeof window.createDimensionCards === 'function') {
                        window.createDimensionCards(result.explorerData);
                    }
                } else {
                    log.info(`🔄 No exploration data from backend - keeping existing cards`);
                }

                if (!result.explorerData && (!state.latestExplorerData || !state.latestExplorerData.directions)) {
                    log.warn('⚠️ Explorer data still missing after refresh; forcing follow-up request');
                    fullResync();
                }

                if (result.currentTrack.duration) {
                    if (typeof window.startProgressAnimation === 'function') {
                        startProgressAnimation(result.currentTrack.duration, result.currentTrack.identifier);
                    }
                }

            } else {
                log.warn('🔄 SSE refresh completed but no current track reported');
            }

            return true;

        } else {
            log.error('❌ SSE refresh request failed:', response.status, response.statusText);
            const errorText = await response.text();
            log.error('❌ Error details:', errorText);
        }

    } catch (error) {
        log.error('❌ SSE refresh request error:', error);
    }

    return false;
}

export async function manualRefresh() {
    log.info('🔄 Manual refresh requested');

    // First, try to fetch fresh explorer data for current track
    const currentTrackId = state.latestCurrentTrack?.identifier;
    if (currentTrackId) {
        log.info('🔄 Fetching fresh explorer data for current track');
        const { fetchExplorerWithPlaylist } = await import('./explorer-fetch.js');
        const explorerData = await fetchExplorerWithPlaylist(currentTrackId, { forceFresh: true });
        if (explorerData && Object.keys(explorerData.directions || {}).length > 0) {
            log.info('🔄 Explorer data refreshed successfully');
            // Clear manual override so applyDeckRenderFrame doesn't block the render
            clearSelection('deck_render');
            state.latestExplorerData = explorerData;
            if (typeof window.createDimensionCards === 'function') {
                window.createDimensionCards(explorerData, { skipExitAnimation: false, forceRedraw: true });
            }
            return 'explorer_refresh';
        }
        log.warn('🔄 Explorer refresh returned no directions');
    }

    if (!state.streamFingerprint) {
        overrideLog.warn('🛰️ Manual refresh: no fingerprint yet; waiting before attempting rebroadcast');
        const ready = await waitForFingerprint(4000);
        if (!ready || !state.streamFingerprint) {
            overrideLog.warn('🛰️ Manual refresh: fingerprint still missing; escalating to new session');
            await createNewJourneySession('manual_refresh_stage3_no_fingerprint');
            return 'new_session';
        }
    }

    const rebroadcastOk = await requestSSERefresh({ escalate: false, stage: 'rebroadcast' });
    if (rebroadcastOk) {
        log.info('🔄 Manual refresh: heartbeat rebroadcast succeeded');
        return 'rebroadcast';
    }

    overrideLog.warn('🛰️ Manual refresh: rebroadcast did not recover; attempting session rebind');
    const rebindOk = await verifyExistingSessionOrRestart('manual_refresh_stage2', { escalate: false });
    if (rebindOk) {
        log.info('🔄 Manual refresh: session rebind succeeded');
        return 'session_rebind';
    }

    overrideLog.warn('🛰️ Manual refresh: session rebind failed; creating new journey session');
    await createNewJourneySession('manual_refresh_stage3');
    return 'new_session';
}

export function setupManualRefreshButton() {
    const refreshButton = document.getElementById('refreshButton');

    if (!refreshButton) {
        log.warn('🔄 Manual refresh button not found in DOM');
        return;
    }

    let clickTimer = null;
    const DOUBLE_CLICK_DELAY = 666; // ms to wait for second click

    refreshButton.addEventListener('click', () => {
        if (clickTimer) {
            // Second click arrived - it's a double-click (hard reset)
            clearTimeout(clickTimer);
            clickTimer = null;
            handleHardReset();
        } else {
            // First click - wait to see if second click comes
            clickTimer = setTimeout(() => {
                clickTimer = null;
                handleRefresh();
            }, DOUBLE_CLICK_DELAY);
        }
    });

    async function handleRefresh() {
        log.info('🔄 Manual refresh button clicked');
        refreshButton.classList.add('refreshing');

        try {
            const outcome = await manualRefresh();
            log.info(`🔄 Manual refresh completed via ${outcome}`);
            setTimeout(() => refreshButton.classList.remove('refreshing'), 1200);
        } catch (error) {
            log.error('❌ Manual refresh failed:', error);
            refreshButton.classList.remove('refreshing');
        }
    }

    async function handleHardReset() {
        log.warn('🛑 Hard reset requested by user (double-click)');
        refreshButton.classList.add('refreshing');
        try {
            await createNewJourneySession('manual_hard_reset');
        } catch (error) {
            log.error('❌ Hard reset failed:', error);
        } finally {
            setTimeout(() => refreshButton.classList.remove('refreshing'), 1500);
        }
    }

    log.info('🔄 Manual refresh button set up (single-click: refresh, double-click: new session)');
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
