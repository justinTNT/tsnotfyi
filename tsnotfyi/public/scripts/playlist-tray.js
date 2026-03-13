// Playlist tray state management
// Manages the playlist queue with left/right stacks
// Dependencies: globals.js (state), explorer-fetch.js (fetchExplorerWithPlaylist)

import { state, elements } from './globals.js';
import { fetchExplorerWithPlaylist, getPlaylistTrackIds } from './explorer-fetch.js';
import { findTrackInExplorer } from './explorer-utils.js';
import { packUpStackCards, clearStackedPreviewLayer } from './helpers.js';
import { createLogger } from './log.js';
const log = createLogger('tray');

/**
 * Add a track to the playlist queue
 * @param {Object} item - Playlist item
 * @param {string} item.trackId - Track identifier
 * @param {string} item.albumCover - Album cover URL
 * @param {string} item.directionKey - Direction used to select this track
 * @param {Object} item.explorerData - Cached explorer data (for unwind)
 * @param {string} item.title - Track title
 * @param {string} item.artist - Track artist
 */
export function addToPlaylist(item) {
    if (!item || !item.trackId) {
        log.warn('addToPlaylist: Invalid item', item);
        return;
    }

    // Ensure playlist array exists
    if (!Array.isArray(state.playlist)) {
        state.playlist = [];
    }

    // Don't add duplicates
    const exists = state.playlist.some(p => p.trackId === item.trackId);
    if (exists) {
        log.info(`addToPlaylist: Track ${item.trackId.substring(0, 8)} already in playlist`);
        return;
    }

    const playlistItem = {
        trackId: item.trackId,
        albumCover: item.albumCover || null,
        directionKey: item.directionKey || null,
        explorerData: item.explorerData || null,
        title: item.title || 'Unknown',
        artist: item.artist || 'Unknown Artist',
        album: item.album || '',
        addedAt: Date.now()
    };

    state.playlist.push(playlistItem);
    log.info(`addToPlaylist: Added ${item.trackId.substring(0, 8)} (${state.playlist.length} in queue)`);

    // Update tray UI
    renderPlaylistTray();

    return playlistItem;
}

/**
 * Remove the last item from the playlist (unwind)
 * Returns the removed item's cached explorerData for instant display
 * @returns {Object|null} The unwound item, or null if playlist is empty
 */
export function unwindPlaylist() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        log.info('unwindPlaylist: Playlist is empty');
        return null;
    }

    const removed = state.playlist.pop();
    log.info(`unwindPlaylist: Removed ${removed.trackId.substring(0, 8)} (${state.playlist.length} remaining)`);

    // Update tray UI
    renderPlaylistTray();

    return removed;
}

/**
 * Pop the front of the playlist (for track change)
 * @returns {Object|null} The popped item, or null if playlist is empty
 */
export function popPlaylistHead() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        return null;
    }

    const removed = state.playlist.shift();
    log.info(`popPlaylistHead: Popped ${removed.trackId.substring(0, 8)} (${state.playlist.length} remaining)`);

    // Update tray UI
    renderPlaylistTray();

    return removed;
}

/**
 * Get the current "next track" from playlist
 * @returns {Object|null} The current next track item, or null
 */
export function getPlaylistNext() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        return null;
    }
    return state.playlist[0];
}

/**
 * Check if playlist has items (no need to trigger pack-away animation)
 * @returns {boolean}
 */
export function playlistHasItems() {
    return Array.isArray(state.playlist) && state.playlist.length > 0;
}

/**
 * Clear the entire playlist
 */
export function clearPlaylist() {
    state.playlist = [];
    log.info('clearPlaylist: Queue cleared');
    renderPlaylistTray();
}

/**
 * Refresh explorer data for the current playlist position
 * Uses POST /explorer with playlist exclusions
 * @param {string} trackId - Track to get explorer data for
 * @returns {Promise<Object>} Fresh explorer data
 */
export async function refreshExplorerForPlaylist(trackId) {
    if (!trackId) {
        log.warn('refreshExplorerForPlaylist: No trackId');
        return null;
    }

    const data = await fetchExplorerWithPlaylist(trackId, { forceFresh: true });
    return data;
}

/**
 * Get the left stack items (first half of queue, next tracks on top)
 * @returns {Array}
 */
export function getLeftStack() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        return [];
    }
    const midpoint = Math.ceil(state.playlist.length / 2);
    return state.playlist.slice(0, midpoint);
}

/**
 * Get the right stack items (second half of queue, for unwind)
 * @returns {Array}
 */
export function getRightStack() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        return [];
    }
    const midpoint = Math.ceil(state.playlist.length / 2);
    return state.playlist.slice(midpoint);
}

/**
 * Render the playlist tray UI
 * Covers spread evenly left-to-right; hover shows track info below tray
 */
export function renderPlaylistTray() {
    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (!trayRoot) {
        return;
    }

    // Get or create tray strip
    let strip = trayRoot.querySelector('.playlist-strip');

    if (!strip) {
        trayRoot.innerHTML = `<div class="playlist-strip"></div>`;
        strip = trayRoot.querySelector('.playlist-strip');
    }

    const items = Array.isArray(state.playlist) ? state.playlist : [];

    const COVER_SIZE = 120;

    strip.innerHTML = items.map((item, i) => {
        const title = (item.title || '').replace(/"/g, '&quot;');
        const artist = (item.artist || '').replace(/"/g, '&quot;');
        const album = (item.album || '').replace(/"/g, '&quot;');
        return `<div class="playlist-cover" data-track-id="${item.trackId}" data-index="${i}"
                     data-title="${title}" data-artist="${artist}" data-album="${album}">
            <img src="${item.albumCover || ''}" alt="${title}" draggable="false" />
        </div>`;
    }).join('');

    // Position covers: fill the tray width, only overlapping when they don't fit
    const covers = strip.querySelectorAll('.playlist-cover');
    const n = covers.length;
    const trayWidth = strip.offsetWidth || trayRoot.offsetWidth || 300;

    if (n === 1) {
        covers[0].style.left = '0px';
        covers[0].style.zIndex = '1';
    } else if (n > 1) {
        // Ideal step = COVER_SIZE (no overlap). Cap at what fits.
        const maxLeft = trayWidth - COVER_SIZE;
        const idealStep = COVER_SIZE;
        const step = Math.min(idealStep, maxLeft / (n - 1));
        covers.forEach((el, i) => {
            el.style.left = `${Math.round(step * i)}px`;
            el.style.zIndex = String(i + 1);
        });
    }

    // Hover handlers
    strip.querySelectorAll('.playlist-cover').forEach(el => {
        el.addEventListener('mouseenter', () => {
            const t = el.dataset.title || '';
            const a = el.dataset.artist || '';
            const al = el.dataset.album || '';
            showTrackTooltip(t, a, al);
        });
        el.addEventListener('mouseleave', () => {
            hideTrackTooltip();
        });
    });

    // Update tray visibility
    const hasItems = items.length > 0;
    trayRoot.classList.toggle('has-items', hasItems);

    const ids = items.map(p => p.trackId.substring(0, 8));
    log.info(`renderPlaylistTray: ${ids.length} items [${ids.join(', ')}] visible=${hasItems}`);
}

/**
 * Promote the current center card to the playlist tray
 * Animates the card to the tray, then fetches explorer for that track
 */
export async function promoteCenterCardToTray() {
    // Resolve the next track from the user's selection (selectedIdentifier),
    // falling back to the server's recommendation (latestExplorerData.nextTrack).
    let nextTrackObj = null;
    let resolvedDirection = null;

    if (state.selectedIdentifier && state.latestExplorerData) {
        const match = findTrackInExplorer(state.latestExplorerData, state.selectedIdentifier);
        if (match) {
            nextTrackObj = match.track;
            resolvedDirection = match.directionKey;
            log.info(`🎯 Resolved from selectedIdentifier: ${state.selectedIdentifier.substring(0, 8)} dir=${resolvedDirection}`);
        }
    }

    if (!nextTrackObj) {
        const nextTrackEntry = state.latestExplorerData?.nextTrack;
        nextTrackObj = nextTrackEntry?.track || nextTrackEntry;
        resolvedDirection = nextTrackEntry?.directionKey || null;
        if (nextTrackObj) {
            log.info(`🎯 Falling back to server nextTrack recommendation`);
        }
    }

    const trackId = nextTrackObj?.identifier;

    if (!trackId) {
        log.warn('promoteCenterCardToTray: no next track in explorer data');
        return null;
    }

    // Never promote the currently-playing track.
    if (trackId === state.latestCurrentTrack?.identifier) {
        log.warn(`⚠️ promoteCenterCardToTray: refusing to promote current track ${trackId.substring(0, 8)}`);
        return null;
    }

    // We still need the DOM card for the fly-to-tray animation
    const centerCard = document.querySelector('.dimension-card.next-track');

    // Resolve album cover with DOM fallback — the card renderer has a richer
    // fallback chain than the data object, so the .photo div may have a cover
    // even when nextTrackObj.albumCover is empty.
    let albumCover = nextTrackObj?.albumCover || '';
    if (!albumCover && centerCard) {
        const photoEl = centerCard.querySelector('.photo');
        if (photoEl) {
            const bg = photoEl.style.backgroundImage || window.getComputedStyle(photoEl).backgroundImage;
            const urlMatch = bg && bg.match(/url\(['"]?(.*?)['"]?\)/);
            if (urlMatch && urlMatch[1]) {
                albumCover = urlMatch[1];
            }
        }
    }
    const title = nextTrackObj?.title || 'Unknown';
    const artist = nextTrackObj?.artist || 'Unknown Artist';
    const album = nextTrackObj?.album || '';

    log.info(`🎯 Promoting center card to tray: ${trackId.substring(0, 8)} (${title})`);

    // Check if playlist is empty BEFORE adding (first item needs server notification)
    const wasEmpty = !playlistHasItems();

    // Cache current explorer data for unwind
    const explorerData = state.latestExplorerData ? JSON.parse(JSON.stringify(state.latestExplorerData)) : null;

    // Add to playlist
    log.info(`🎯 Adding to playlist: ${trackId?.substring(0, 8)} (${title})`);
    const item = addToPlaylist({
        trackId,
        albumCover,
        directionKey: resolvedDirection,
        explorerData,
        title,
        artist,
        album
    });

    if (!item) {
        log.info('🎯 addToPlaylist returned falsy - track may be duplicate or invalid');
        return null;
    }
    log.info(`🎯 Added to playlist successfully, playlist length: ${state.playlist?.length}`);

    // Only tell server if this is the first item (immediate next track needed)
    if (wasEmpty && typeof window.sendNextTrack === 'function') {
        log.info(`🎯 First playlist item - notifying server: ${trackId.substring(0, 8)}`);
        window.sendNextTrack(trackId, resolvedDirection, 'user');
    }

    // Step 1: Pack up stack cards first
    await packUpStackCards();

    // Step 2: Start fetching explorer data (don't await yet)
    log.info(`🎯 Fetching explorer for promoted track: ${trackId.substring(0, 8)}`);
    const explorerPromise = fetchExplorerWithPlaylist(trackId, { forceFresh: true });

    // Step 3: Start the deck exit animation (cards zoom away)
    // This runs in parallel - we don't await it
    if (typeof window.createDimensionCards === 'function') {
        // Trigger exit animation with a placeholder that will be replaced
        const deckContainer = document.getElementById('dimensionCards');
        if (deckContainer) {
            const exitingCards = deckContainer.querySelectorAll('.dimension-card');
            exitingCards.forEach(card => {
                const computed = window.getComputedStyle(card);
                const baseTransform = card.style.transform || computed.transform || '';
                const exitTransform = baseTransform && baseTransform !== 'none'
                    ? `${baseTransform} translateZ(-1200px) scale(0.2)`
                    : 'translateZ(-1200px) scale(0.2)';

                card.classList.add('card-exit');
                card.style.pointerEvents = 'none';
                card.style.transition = 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.45s ease';

                requestAnimationFrame(() => {
                    card.style.opacity = '0';
                    card.style.transform = exitTransform;
                });
            });
        }
    }

    // Step 4: Brief pause for exit animation to register, then proceed
    await new Promise(resolve => setTimeout(resolve, 150));

    // Step 5: Wait for explorer data and render new cards
    try {
        const newExplorerData = await explorerPromise;
        log.info('🎯 Explorer data received:', {
            hasData: !!newExplorerData,
            directionCount: Object.keys(newExplorerData?.directions || {}).length,
            nextTrack: newExplorerData?.nextTrack?.directionKey || 'none',
            nextTrackId: newExplorerData?.nextTrack?.track?.identifier?.substring(0, 8) || 'none'
        });
        if (newExplorerData) {
            state.latestExplorerData = newExplorerData;
            if (typeof window.createDimensionCards === 'function') {
                // isPlaylistExploration: true prevents polluting now-playing state
                // skipExitAnimation: true since we already triggered exit above
                log.info('🎯 Calling createDimensionCards with new explorer data');
                window.createDimensionCards(newExplorerData, {
                    skipExitAnimation: true,
                    forceRedraw: true,
                    isPlaylistExploration: true
                });
            }
        }
    } catch (error) {
        log.error('promoteCenterCardToTray: Explorer fetch failed', error);
    }

    return item;
}

/**
 * Animate a card sliding to the tray
 */
/**
 * Initialize playlist tray event handlers
 */
export function initPlaylistTray() {
    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (!trayRoot) {
        return;
    }

    // Initialize tray structure
    renderPlaylistTray();

    // Cover click — unwind back to that position
    trayRoot.addEventListener('click', (e) => {
        const cover = e.target.closest('.playlist-cover');
        if (cover) {
            const idx = parseInt(cover.dataset.index, 10);
            if (Number.isFinite(idx)) {
                // Unwind from the end back to this item
                while (Array.isArray(state.playlist) && state.playlist.length > idx + 1) {
                    unwindPlaylist();
                }
                const unwound = unwindPlaylist();
                if (unwound && unwound.explorerData) {
                    if (typeof window.createDimensionCards === 'function') {
                        window.createDimensionCards(unwound.explorerData, { skipExitAnimation: true });
                    }
                }
            }
        }
    });

    // Clicking anywhere left of the clock promotes the center card to the tray.
    // The right stack's top item is excluded (it unwinds instead).
    // Clicking the now-playing card promotes the next track to the tray
    const nowPlayingCard = document.getElementById('nowPlayingCard');
    if (nowPlayingCard) {
        nowPlayingCard.addEventListener('click', () => {
            promoteCenterCardToTray();
        });
    }
}

/**
 * Shared track hover tooltip — fixed at bottom center of viewport
 */
let _tooltip = null;
function getTooltip() {
    if (_tooltip && _tooltip.isConnected) return _tooltip;
    _tooltip = document.querySelector('.track-hover-tooltip');
    if (!_tooltip) {
        _tooltip = document.createElement('div');
        _tooltip.className = 'track-hover-tooltip';
        document.body.appendChild(_tooltip);
    }
    return _tooltip;
}

export function showTrackTooltip(title, artist, album) {
    const tip = getTooltip();
    const parts = [title, artist, album].filter(Boolean);
    tip.textContent = parts.join(' \u2014 ');
    tip.classList.add('visible');
}

export function hideTrackTooltip() {
    const tip = getTooltip();
    tip.classList.remove('visible');
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.addToPlaylist = addToPlaylist;
    window.unwindPlaylist = unwindPlaylist;
    window.popPlaylistHead = popPlaylistHead;
    window.getPlaylistNext = getPlaylistNext;
    window.playlistHasItems = playlistHasItems;
    window.clearPlaylist = clearPlaylist;
    window.refreshExplorerForPlaylist = refreshExplorerForPlaylist;
    window.getLeftStack = getLeftStack;
    window.getRightStack = getRightStack;
    window.renderPlaylistTray = renderPlaylistTray;
    window.initPlaylistTray = initPlaylistTray;
    window.promoteCenterCardToTray = promoteCenterCardToTray;
    window.showTrackTooltip = showTrackTooltip;
    window.hideTrackTooltip = hideTrackTooltip;
}
