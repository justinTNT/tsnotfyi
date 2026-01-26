// Playlist tray state management
// Manages the playlist queue with left/right stacks
// Dependencies: globals.js (state), explorer-fetch.js (fetchExplorerWithPlaylist)

import { state, elements } from './globals.js';
import { fetchExplorerWithPlaylist, getPlaylistTrackIds } from './explorer-fetch.js';
import { packUpStackCards, clearStackedPreviewLayer } from './helpers.js';

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
        console.warn('addToPlaylist: Invalid item', item);
        return;
    }

    // Ensure playlist array exists
    if (!Array.isArray(state.playlist)) {
        state.playlist = [];
    }

    // Don't add duplicates
    const exists = state.playlist.some(p => p.trackId === item.trackId);
    if (exists) {
        console.log(`addToPlaylist: Track ${item.trackId.substring(0, 8)} already in playlist`);
        return;
    }

    const playlistItem = {
        trackId: item.trackId,
        albumCover: item.albumCover || null,
        directionKey: item.directionKey || null,
        explorerData: item.explorerData || null,
        title: item.title || 'Unknown',
        artist: item.artist || 'Unknown Artist',
        addedAt: Date.now()
    };

    state.playlist.push(playlistItem);
    console.log(`addToPlaylist: Added ${item.trackId.substring(0, 8)} (${state.playlist.length} in queue)`);

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
        console.log('unwindPlaylist: Playlist is empty');
        return null;
    }

    const removed = state.playlist.pop();
    console.log(`unwindPlaylist: Removed ${removed.trackId.substring(0, 8)} (${state.playlist.length} remaining)`);

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
    console.log(`popPlaylistHead: Popped ${removed.trackId.substring(0, 8)} (${state.playlist.length} remaining)`);

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
    state.playlistCursor = 0;
    console.log('clearPlaylist: Queue cleared');
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
        console.warn('refreshExplorerForPlaylist: No trackId');
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
 * Left stack: first items (queue head on top), Right stack: last items (for unwind)
 */
export function renderPlaylistTray() {
    const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
    if (!trayRoot) {
        return;
    }

    // Get or create tray containers
    let leftStack = trayRoot.querySelector('.playlist-left-stack');
    let rightStack = trayRoot.querySelector('.playlist-right-stack');

    if (!leftStack || !rightStack) {
        // Initialize tray structure if not present
        trayRoot.innerHTML = `
            <div class="playlist-left-stack"></div>
            <div class="playlist-right-stack"></div>
        `;
        leftStack = trayRoot.querySelector('.playlist-left-stack');
        rightStack = trayRoot.querySelector('.playlist-right-stack');
    }

    // Render left stack (first half of queue, next track on top)
    const leftItems = getLeftStack();
    leftStack.innerHTML = leftItems.map((item, i) => `
        <div class="stack-item" data-track-id="${item.trackId}" data-index="${i}">
            <img src="${item.albumCover || ''}" alt="${item.title}" />
        </div>
    `).join('');

    // Render right stack (second half of queue, last track on top for unwind)
    const rightItems = getRightStack();
    // Reverse so most recent (last added) is on top
    const rightItemsReversed = [...rightItems].reverse();
    rightStack.innerHTML = rightItemsReversed.map((item, i) => `
        <div class="stack-item" data-track-id="${item.trackId}" data-index="${i}">
            <img src="${item.albumCover || ''}" alt="${item.title}" />
        </div>
    `).join('');

    // Update tray visibility
    const hasItems = playlistHasItems();
    trayRoot.classList.toggle('has-items', hasItems);
}

/**
 * Promote the current center card to the playlist tray
 * Animates the card to the tray, then fetches explorer for that track
 */
export async function promoteCenterCardToTray() {
    // Find the current center card (next-track)
    const centerCard = document.querySelector('.dimension-card.next-track');
    console.log('🎯 promoteCenterCardToTray: Looking for center card', {
        found: !!centerCard,
        allCards: document.querySelectorAll('.dimension-card').length,
        nextTrackCards: document.querySelectorAll('.dimension-card.next-track').length
    });
    if (!centerCard) {
        console.log('promoteCenterCardToTray: No center card found');
        return null;
    }

    // Extract track info from the center card
    const directionKey = centerCard.dataset.directionKey;
    const trackIndex = parseInt(centerCard.dataset.trackIndex, 10) || 0;

    // Get track from explorer data for reliability (dataset may be stale)
    const direction = state.latestExplorerData?.directions?.[directionKey];
    const sampleTracks = direction?.sampleTracks || [];
    const currentSample = sampleTracks[trackIndex] || sampleTracks[0];
    const currentTrack = currentSample?.track || currentSample;

    // Use explorer data if available, fall back to dataset/state
    const trackId = currentTrack?.identifier || centerCard.dataset.trackMd5 || state.selectedIdentifier;
    const albumCover = currentTrack?.albumCover || '';
    const title = currentTrack?.title || centerCard.dataset.trackTitle || 'Unknown';
    const artist = currentTrack?.artist || centerCard.dataset.trackArtist || 'Unknown Artist';

    console.log(`🎯 Promote: direction=${directionKey}, trackIndex=${trackIndex}, trackId=${trackId?.substring(0,8)}, title=${title}`);

    if (!trackId) {
        console.warn('promoteCenterCardToTray: No trackId found on center card');
        return null;
    }

    console.log(`🎯 Promoting center card to tray: ${trackId.substring(0, 8)} (${title})`);

    // Check if playlist is empty BEFORE adding (first item needs server notification)
    const wasEmpty = !playlistHasItems();

    // Cache current explorer data for unwind
    const explorerData = state.latestExplorerData ? JSON.parse(JSON.stringify(state.latestExplorerData)) : null;

    // Add to playlist
    console.log(`🎯 Adding to playlist: ${trackId?.substring(0, 8)} (${title})`);
    const item = addToPlaylist({
        trackId,
        albumCover,
        directionKey,
        explorerData,
        title,
        artist
    });

    if (!item) {
        console.log('🎯 addToPlaylist returned falsy - track may be duplicate or invalid');
        return null;
    }
    console.log(`🎯 Added to playlist successfully, playlist length: ${state.playlist?.length}`);

    // Only tell server if this is the first item (immediate next track needed)
    if (wasEmpty && typeof window.sendNextTrack === 'function') {
        console.log(`🎯 First playlist item - notifying server: ${trackId.substring(0, 8)}`);
        window.sendNextTrack(trackId, directionKey, 'user');
    }

    // Step 1: Pack up stack cards first
    await packUpStackCards();

    // Step 2: Start fetching explorer data (don't await yet)
    console.log(`🎯 Fetching explorer for promoted track: ${trackId.substring(0, 8)}`);
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

    // Step 4: After a brief delay, animate the cover to tray
    await new Promise(resolve => setTimeout(resolve, 150));
    await animateCardToTray(centerCard, albumCover);

    // Step 5: Wait for explorer data and render new cards
    try {
        const newExplorerData = await explorerPromise;
        console.log('🎯 Explorer data received:', {
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
                console.log('🎯 Calling createDimensionCards with new explorer data');
                window.createDimensionCards(newExplorerData, {
                    skipExitAnimation: true,
                    forceRedraw: true,
                    isPlaylistExploration: true
                });
            }
        }
    } catch (error) {
        console.error('promoteCenterCardToTray: Explorer fetch failed', error);
    }

    return item;
}

/**
 * Animate a card sliding to the tray
 */
function animateCardToTray(card, albumCover) {
    return new Promise((resolve) => {
        const trayRoot = elements.nextTrackTray || document.getElementById('nextTrackTray');
        const leftStack = trayRoot?.querySelector('.playlist-left-stack');

        if (!leftStack || !albumCover) {
            resolve();
            return;
        }

        // Create a clone that will animate to the tray
        const clone = document.createElement('div');
        clone.className = 'stack-item animating-to-tray';
        clone.innerHTML = `<img src="${albumCover}" alt="Album cover" />`;

        // Get positions
        const cardRect = card.getBoundingClientRect();
        const trayRect = leftStack.getBoundingClientRect();

        // Start at card position
        clone.style.cssText = `
            position: fixed;
            left: ${cardRect.left}px;
            top: ${cardRect.top}px;
            width: ${cardRect.width}px;
            height: ${cardRect.height}px;
            border-radius: 8px;
            overflow: hidden;
            z-index: 1000;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            pointer-events: none;
        `;
        document.body.appendChild(clone);

        // Trigger animation on next frame
        requestAnimationFrame(() => {
            clone.style.left = `${trayRect.left}px`;
            clone.style.top = `${trayRect.top}px`;
            clone.style.width = '80px';
            clone.style.height = '80px';

            // Fade in shrinkwrap overlay midway through animation
            setTimeout(() => {
                clone.classList.add('shrinkwrap-visible');
            }, 150);
        });

        // Clean up after animation
        setTimeout(() => {
            clone.remove();
            renderPlaylistTray();
            resolve();
        }, 450);
    });
}

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

    trayRoot.addEventListener('click', (e) => {
        // Handle left stack click - promote center card to tray
        const leftStack = e.target.closest('.playlist-left-stack');
        if (leftStack) {
            console.log('Left stack clicked - promoting center card');
            promoteCenterCardToTray();
            return;
        }

        // Handle right stack click - unwind queue
        const rightItem = e.target.closest('.playlist-right-stack .stack-item');
        if (rightItem) {
            console.log('Right stack item clicked - unwinding');
            const unwound = unwindPlaylist();
            if (unwound && unwound.explorerData) {
                // Display cached explorer data instantly (no fetch needed)
                if (typeof window.createDimensionCards === 'function') {
                    window.createDimensionCards(unwound.explorerData, { skipExitAnimation: true });
                }
            }
            return;
        }
    });
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
}
