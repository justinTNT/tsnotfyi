// Playlist tray state management
// Manages the playlist queue with left/right stacks
// Dependencies: globals.js (state), explorer-fetch.js (fetchExplorerWithPlaylist)

import { state, elements } from './globals.js';
import { fetchExplorerWithPlaylist, getPlaylistTrackIds } from './explorer-fetch.js';
import { findTrackInExplorer } from './explorer-utils.js';
import { packUpStackCards, clearStackedPreviewLayer } from './helpers.js';
import { createLogger } from './log.js';
import { clearSelection } from './selection.js';
const log = createLogger('tray');

const PASTEL_COLORS = [
    '#ffaaaa', // light red
    '#aaffaa', // light green
    '#aaaaff', // light blue
    '#ffffaa', // light yellow (rg)
    '#aaffff', // light cyan
    '#ffaaff', // light magenta
    '#cccccc', // light grey
];

function pastelFromString(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return PASTEL_COLORS[((h % PASTEL_COLORS.length) + PASTEL_COLORS.length) % PASTEL_COLORS.length];
}

function monthFromPath(path) {
    if (!path) return '';
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    // volume/year/month/artist/album/track.mp3 → month is parts[-4]
    return parts.length >= 4 ? parts[parts.length - 4] : '';
}

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
        path: item.path || null,
        folderLabel: item.folderLabel || '',
        folderPath: item.folderPath || null,
        trackNumber: item.trackNumber || null,
        discNumber: item.discNumber || null,
        folderTrackTotal: item.folderTrackTotal || null,
        duration: item.duration || null,
        addedAt: Date.now()
    };

    state.playlist.push(playlistItem);
    log.info(`addToPlaylist: Added ${item.trackId.substring(0, 8)} (${state.playlist.length} in queue)`);

    // Update tray UI
    renderPlaylistTray();

    return playlistItem;
}

/**
 * Load an entire album (folder tracks) to the playlist tray.
 * Shift+Enter on center card or Shift+click/enter from fzf.
 */
async function loadAlbumToTray(trackId) {
    log.info(`📂 Loading album to tray for track ${trackId.substring(0, 8)}`);
    try {
        const resp = await fetch(`/api/folder-tracks/${trackId}`);
        if (!resp.ok) {
            log.error(`📂 Folder tracks fetch failed: ${resp.status}`);
            return;
        }
        const data = await resp.json();
        if (!data.tracks || data.tracks.length === 0) {
            log.info('📂 No tracks found in folder');
            return;
        }

        const existingIds = new Set((state.playlist || []).map(p => p.trackId));
        const wasEmpty = !Array.isArray(state.playlist) || state.playlist.length === 0;
        let added = 0;

        const totalTracks = data.tracks.length;
        for (const track of data.tracks) {
            if (existingIds.has(track.identifier)) continue;
            addToPlaylist({
                trackId: track.identifier,
                albumCover: track.albumCover || '/images/albumcover.png',
                directionKey: null,
                title: track.title || 'Unknown',
                artist: track.artist || 'Unknown Artist',
                album: track.album || '',
                folderLabel: '',
                folderPath: data.folder,
                trackNumber: track.track,
                discNumber: track.disc,
                folderTrackTotal: totalTracks,
                duration: track.duration || null
            });
            added++;
        }

        log.info(`📂 Added ${added} tracks from ${data.folder.split('/').pop()}`);

        if (wasEmpty && added > 0 && typeof window.sendNextTrack === 'function') {
            const head = getPlaylistNext();
            if (head) {
                window.sendNextTrack(head.trackId, head.directionKey, 'user');
            }
        }

        // If album is at the tail of the tray, fetch explorer for the last album track
        // so the deck shows where to go after the album ends
        if (added > 0 && typeof fetchExplorerWithPlaylist === 'function') {
            const lastItem = state.playlist[state.playlist.length - 1];
            const lastAlbumTrack = data.tracks[data.tracks.length - 1];
            if (lastItem && lastAlbumTrack && lastItem.trackId === lastAlbumTrack.identifier) {
                log.info(`📂 Fetching explorer for album tail: ${lastAlbumTrack.identifier.substring(0, 8)}`);
                fetchExplorerWithPlaylist(lastAlbumTrack.identifier, { forceFresh: true }).then(explorerData => {
                    if (explorerData && typeof window.createDimensionCards === 'function') {
                        state.latestExplorerData = explorerData;
                        window.createDimensionCards(explorerData, {
                            skipExitAnimation: true,
                            forceRedraw: true,
                            isPlaylistExploration: true
                        });
                    }
                }).catch(err => {
                    log.warn('📂 Explorer fetch for album tail failed:', err?.message || err);
                });
            }
        }
    } catch (err) {
        log.error('📂 Album load failed:', err);
    }
}

/**
 * Unfold album: replace a single playlist item with all tracks from its folder.
 * Shift-click on a tray cover triggers this.
 */
async function unfoldAlbum(trackId, playlistIndex) {
    log.info(`📂 Unfolding album for track ${trackId.substring(0, 8)} at index ${playlistIndex}`);
    try {
        const resp = await fetch(`/api/folder-tracks/${trackId}`);
        if (!resp.ok) {
            log.error(`📂 Folder tracks fetch failed: ${resp.status}`);
            return;
        }
        const data = await resp.json();
        if (!data.tracks || data.tracks.length <= 1) {
            log.info('📂 Only one track in folder, nothing to unfold');
            return;
        }

        // Find the clicked track's position in the folder
        const clickedIndex = data.tracks.findIndex(t => t.identifier === trackId);
        if (clickedIndex < 0) {
            log.warn('📂 Clicked track not found in folder results');
            return;
        }

        // Build playlist items for ALL folder tracks
        const original = state.playlist[playlistIndex];
        const totalTracks = data.tracks.length;
        const folderItems = data.tracks.map(track => ({
            trackId: track.identifier,
            albumCover: track.albumCover || original?.albumCover || '/images/albumcover.png',
            directionKey: original?.directionKey || null,
            explorerData: null,
            title: track.title || 'Unknown',
            artist: track.artist || original?.artist || 'Unknown Artist',
            album: track.album || original?.album || '',
            folderLabel: original?.folderLabel || '',
            addedAt: Date.now(),
            // Folder metadata for gapless detection
            folderPath: data.folder,
            trackNumber: track.track,
            discNumber: track.disc,
            folderTrackTotal: totalTracks
        }));

        // Remove duplicates (tracks already in playlist)
        const existingIds = new Set(state.playlist.map(p => p.trackId));
        const newItems = folderItems.filter(item => !existingIds.has(item.trackId) || item.trackId === trackId);

        // Replace the clicked item with the unfolded tracks
        state.playlist.splice(playlistIndex, 1, ...newItems);

        log.info(`📂 Unfolded: ${newItems.length} tracks from ${data.folder.split('/').pop()}`);
        renderPlaylistTray();

        // If unfolded item is at the head, notify server of the (possibly new) head
        if (playlistIndex === 0 && newItems.length > 0 && newItems[0].trackId !== trackId) {
            if (typeof window.sendNextTrack === 'function') {
                window.sendNextTrack(newItems[0].trackId, newItems[0].directionKey, 'user');
            }
        }

        // If album is at the tail of the tray, fetch explorer for the last album track
        if (newItems.length > 0 && typeof fetchExplorerWithPlaylist === 'function') {
            const lastPlaylistItem = state.playlist[state.playlist.length - 1];
            const lastNewItem = newItems[newItems.length - 1];
            if (lastPlaylistItem && lastNewItem && lastPlaylistItem.trackId === lastNewItem.trackId) {
                log.info(`📂 Fetching explorer for unfolded album tail: ${lastNewItem.trackId.substring(0, 8)}`);
                fetchExplorerWithPlaylist(lastNewItem.trackId, { forceFresh: true }).then(explorerData => {
                    if (explorerData && typeof window.createDimensionCards === 'function') {
                        state.latestExplorerData = explorerData;
                        window.createDimensionCards(explorerData, {
                            skipExitAnimation: true,
                            forceRedraw: true,
                            isPlaylistExploration: true
                        });
                    }
                }).catch(err => {
                    log.warn('📂 Explorer fetch for unfolded album tail failed:', err?.message || err);
                });
            }
        }
    } catch (err) {
        log.error('📂 Album unfold failed:', err);
    }
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

    // Show playlist name label when first track from a named playlist starts
    if (state.activePlaylistName) {
        setPlaylistNameLabel(state.activePlaylistName);
    }

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
 * Get the last item in the playlist (the track after which explorer options apply)
 * @returns {object|null}
 */
export function getPlaylistTail() {
    if (!Array.isArray(state.playlist) || state.playlist.length === 0) {
        return null;
    }
    return state.playlist[state.playlist.length - 1];
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
    const STACK_OFFSET = 6; // pixels each stacked album track peeks above

    // Group consecutive same-folder items into visual slots
    const slots = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const folder = item.folderPath || null;
        const prevSlot = slots[slots.length - 1];
        if (folder && prevSlot && prevSlot.folder === folder) {
            prevSlot.items.push({ item, playlistIndex: i });
        } else {
            slots.push({ folder, items: [{ item, playlistIndex: i }] });
        }
    }

    // Render each slot — single items render normally, album groups stack vertically
    strip.innerHTML = slots.map((slot, slotIdx) => {
        const first = slot.items[0].item;
        const count = slot.items.length;
        const isAlbumStack = count > 1;
        const stackHeight = isAlbumStack ? STACK_OFFSET * (count - 1) : 0;

        if (isAlbumStack) {
            // Album stack: first cover is the front, subsequent peek above
            const coversHtml = slot.items.map(({ item, playlistIndex }, j) => {
                const title = (item.title || '').replace(/"/g, '&quot;');
                const artist = (item.artist || '').replace(/"/g, '&quot;');
                const album = (item.album || '').replace(/"/g, '&quot;');
                const offsetY = -(count - 1 - j) * STACK_OFFSET;
                const zIdx = j + 1;
                const dur = item.duration || null;
                return `<div class="playlist-cover album-stacked" data-track-id="${item.trackId}" data-index="${playlistIndex}"
                             data-title="${title}" data-artist="${artist}" data-album="${album}" data-duration="${dur || ''}"
                             style="position:absolute; top:${offsetY}px; left:0; z-index:${zIdx}">
                    <img src="${item.albumCover || ''}" alt="${title}" draggable="false" />
                </div>`;
            }).join('');

            return `<div class="playlist-slot album-stack" data-slot="${slotIdx}" data-count="${count}"
                         style="height:${COVER_SIZE}px">
                ${coversHtml}
                <span class="album-stack-count">${first.trackNumber || 1}/${first.folderTrackTotal || count}</span>
            </div>`;
        } else {
            const item = first;
            const playlistIndex = slot.items[0].playlistIndex;
            const title = (item.title || '').replace(/"/g, '&quot;');
            const artist = (item.artist || '').replace(/"/g, '&quot;');
            const album = (item.album || '').replace(/"/g, '&quot;');
            const isDefault = !item.albumCover || item.albumCover === '/images/albumcover.png';
            const label = isDefault ? (item.folderLabel || monthFromPath(item.path)) : '';
            const labelHtml = label
                ? `<span class="playlist-cover-label" style="color:${pastelFromString(label)}">${label.replace(/</g, '&lt;')}</span>`
                : '';
            const dur = item.duration || null;
            return `<div class="playlist-slot">
                <div class="playlist-cover" data-track-id="${item.trackId}" data-index="${playlistIndex}"
                         data-title="${title}" data-artist="${artist}" data-album="${album}" data-duration="${dur || ''}">
                    <img src="${item.albumCover || ''}" alt="${title}" draggable="false" />
                    ${labelHtml}
                </div>
            </div>`;
        }
    }).join('');

    // Position slots horizontally
    const slotEls = strip.querySelectorAll('.playlist-slot');
    const numSlots = slotEls.length;
    const trayWidth = strip.offsetWidth || trayRoot.offsetWidth || 300;

    if (numSlots === 1) {
        slotEls[0].style.left = '0px';
        slotEls[0].style.zIndex = '1';
    } else if (numSlots > 1) {
        const maxLeft = trayWidth - COVER_SIZE;
        const idealStep = COVER_SIZE;
        const step = Math.min(idealStep, maxLeft / (numSlots - 1));
        slotEls.forEach((el, i) => {
            el.style.left = `${Math.round(step * i)}px`;
            el.style.zIndex = String(i + 1);
        });
    }

    // Hover + click handlers on all covers
    strip.querySelectorAll('.playlist-cover').forEach(el => {
        el.addEventListener('mouseenter', () => {
            const t = el.dataset.title || '';
            const a = el.dataset.artist || '';
            const al = el.dataset.album || '';
            const dur = parseFloat(el.dataset.duration);
            const durStr = Number.isFinite(dur) ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}` : '';
            showTrackTooltip(t, a, al, durStr);
        });
        el.addEventListener('mouseleave', () => {
            hideTrackTooltip();
        });
        // Shift-click: unfold album (all tracks from same folder)
        el.addEventListener('click', async (e) => {
            if (!e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            window.getSelection()?.removeAllRanges();
            const trackId = el.dataset.trackId;
            const index = parseInt(el.dataset.index);
            if (!trackId || isNaN(index)) return;
            await unfoldAlbum(trackId, index);
        });
    });

    // Update tray visibility
    const hasItems = items.length > 0;
    trayRoot.classList.toggle('has-items', hasItems);

    // Clear playlist name when tray empties
    if (!hasItems) {
        state.activePlaylistName = null;
        setPlaylistNameLabel('');
    }

    // Always update save/load button visibility
    updateSaveButtonState();

    const ids = items.map(p => p.trackId.substring(0, 8));
    log.info(`renderPlaylistTray: ${ids.length} items [${ids.join(', ')}] visible=${hasItems}`);
}

/**
 * Promote the current center card to the playlist tray
 * Animates the card to the tray, then fetches explorer for that track
 */
export async function promoteCenterCardToTray() {
    // Primary source: the center card's DOM state (what the user is looking at).
    // Fallback: state.selection.trackId matched against explorer data.
    // Last resort: server's nextTrack recommendation.
    let nextTrackObj = null;
    let resolvedDirection = null;

    // 1. Read directly from the center card DOM — this is what the user sees
    const centerCard = document.querySelector('.dimension-card.next-track');
    const centerTrackId = centerCard?.dataset?.trackMd5;
    const centerDirectionKey = centerCard?.dataset?.directionKey;

    if (centerTrackId) {
        // Try to enrich from explorer data, but use DOM data regardless
        const match = state.latestExplorerData ? findTrackInExplorer(state.latestExplorerData, centerTrackId) : null;
        if (match) {
            nextTrackObj = match.track;
            resolvedDirection = match.directionKey || centerDirectionKey;
        } else {
            // Explorer data doesn't contain this track (refreshed since cycle) — use card data
            nextTrackObj = {
                identifier: centerTrackId,
                title: centerCard.dataset.trackTitle || '',
                artist: centerCard.dataset.trackArtist || '',
                album: centerCard.dataset.trackAlbum || '',
                albumCover: centerCard.dataset.trackAlbumCover || '',
                duration: parseFloat(centerCard.dataset.trackDurationSeconds) || null
            };
            resolvedDirection = centerDirectionKey;
        }
        log.info(`🎯 Resolved from center card DOM: ${centerTrackId.substring(0, 8)} dir=${resolvedDirection} (explorer match: ${!!match})`);
    }

    // 2. Fall back to selection state (may differ from DOM if explorer refreshed)
    if (!nextTrackObj && state.selection.trackId && state.latestExplorerData) {
        const match = findTrackInExplorer(state.latestExplorerData, state.selection.trackId);
        if (match) {
            nextTrackObj = match.track;
            resolvedDirection = match.directionKey;
            log.info(`🎯 Resolved from selection.trackId: ${state.selection.trackId.substring(0, 8)} dir=${resolvedDirection}`);
        }
    }

    // 3. Fall back to server recommendation
    if (!nextTrackObj) {
        const nextTrackEntry = state.latestExplorerData?.nextTrack;
        nextTrackObj = nextTrackEntry?.track || nextTrackEntry;
        resolvedDirection = nextTrackEntry?.directionKey || null;
        log.warn(`🎯 Falling back to server nextTrack recommendation`, {
            centerCardExists: !!centerCard,
            centerTrackId: centerTrackId?.substring(0, 8) || null,
            selectionTrackId: state.selection.trackId?.substring(0, 8) || null,
            selectionSource: state.selection.source,
            serverNextId: nextTrackObj?.identifier?.substring(0, 8) || null
        });
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
    // (centerCard already resolved above)

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
        folderLabel: nextTrackObj?.folderLabel || '',
        directionKey: resolvedDirection,
        explorerData,
        title,
        artist,
        album,
        duration: nextTrackObj?.duration || nextTrackObj?.length || null
    });

    if (!item) {
        log.info('🎯 addToPlaylist returned falsy - track may be duplicate or invalid');
        // Visual feedback: briefly flash the existing item in the tray
        if (centerCard) {
            centerCard.classList.add('duplicate-flash');
            setTimeout(() => centerCard.classList.remove('duplicate-flash'), 400);
        }
        return null;
    }
    log.info(`🎯 Added to playlist successfully, playlist length: ${state.playlist?.length}`);

    // Clear selection so next promote picks a fresh recommendation
    clearSelection('promoted');

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

    // Playlist control buttons
    const btnLoad = document.getElementById('btnLoadPlaylist');
    const btnSave = document.getElementById('btnSaveSession');
    if (btnLoad) btnLoad.addEventListener('click', () => showPlaylistPicker());
    if (btnSave) btnSave.addEventListener('click', () => {
        // Save tray contents only (not session history)
        const tracks = [];
        for (const item of (state.playlist || [])) {
            tracks.push({
                identifier: item.trackId,
                direction: item.directionKey || null,
                folderPath: item.folderPath || null,
                trackNumber: item.trackNumber || null,
                discNumber: item.discNumber || null
            });
        }
        if (tracks.length === 0) return;
        const payload = btoa(JSON.stringify({ tracks }));
        window.open(`/playlists?session=${encodeURIComponent(payload)}`, '_blank');
    });

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
 * Show/hide save and load buttons based on tray state.
 * Save: visible when tray has items (and no active named playlist).
 * Load: visible when tray is empty.
 */
function updateSaveButtonState() {
    const btnSave = document.getElementById('btnSaveSession');
    const btnLoad = document.getElementById('btnLoadPlaylist');
    const hasItems = Array.isArray(state.playlist) && state.playlist.length > 0;
    const namedActive = !!state.activePlaylistName;

    if (btnSave) {
        const showSave = hasItems && !namedActive;
        btnSave.style.display = showSave ? '' : 'none';
    }
    if (btnLoad) {
        btnLoad.style.display = hasItems ? 'none' : '';
    }
}

/**
 * Show or hide the playlist name label above the now-playing card
 */
function setPlaylistNameLabel(name) {
    const el = document.getElementById('playlistNameLabel');
    if (!el) return;
    if (name) {
        el.textContent = name;
        el.classList.add('visible');
    } else {
        el.classList.remove('visible');
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

export function showTrackTooltip(title, artist, album, duration) {
    const tip = getTooltip();
    const parts = [title, artist, album, duration].filter(Boolean);
    tip.textContent = parts.join(' \u2014 ');
    tip.classList.add('visible');
}

export function hideTrackTooltip() {
    const tip = getTooltip();
    tip.classList.remove('visible');
}

/**
 * Load a playlist from the database into the tray
 * @param {number} playlistId - Database playlist ID
 * @returns {Promise<number>} Number of tracks loaded
 */
export async function loadPlaylistIntoTray(playlistId) {
    log.info(`loadPlaylistIntoTray: loading playlist ${playlistId}`);

    const res = await fetch(`/api/playlists/${playlistId}`);
    if (!res.ok) {
        log.error(`loadPlaylistIntoTray: fetch failed ${res.status}`);
        return 0;
    }

    const playlist = await res.json();
    if (!playlist.tracks || playlist.tracks.length === 0) {
        log.info('loadPlaylistIntoTray: playlist has no tracks');
        return 0;
    }

    // Clear existing tray
    clearPlaylist();

    // Add each track to the tray (skip duplicates of current track)
    const currentId = state.latestCurrentTrack?.identifier;
    let loaded = 0;
    for (const track of playlist.tracks) {
        if (track.identifier === currentId) continue;
        addToPlaylist({
            trackId: track.identifier,
            albumCover: track.albumCover || '/images/albumcover.png',
            directionKey: track.direction || null,
            explorerData: null,
            title: track.title || 'Unknown',
            artist: track.artist || 'Unknown Artist',
            album: track.album || '',
            path: track.path || null
        });
        loaded++;
    }

    log.info(`loadPlaylistIntoTray: loaded ${loaded} tracks from "${playlist.name}"`);

    // Store name — label shown when first track starts playing (popPlaylistHead)
    state.activePlaylistName = playlist.name || '';
    updateSaveButtonState();

    // Tell the server the first tray item is the next track
    const head = getPlaylistNext();
    if (head && typeof window.sendNextTrack === 'function') {
        log.info(`loadPlaylistIntoTray: notifying server of next track ${head.trackId.substring(0, 8)}`);
        window.sendNextTrack(head.trackId, head.directionKey, 'user');
    }

    // Refresh the clock with explorer data for the last playlist item
    const tail = state.playlist[state.playlist.length - 1];
    if (tail) {
        log.info(`loadPlaylistIntoTray: fetching explorer for tail ${tail.trackId.substring(0, 8)}`);
        fetchExplorerWithPlaylist(tail.trackId, { forceFresh: true }).then(explorerData => {
            if (explorerData) {
                state.latestExplorerData = explorerData;
                if (typeof window.createDimensionCards === 'function') {
                    window.createDimensionCards(explorerData, { skipExitAnimation: true, isPlaylistExploration: true });
                }
            }
        }).catch(err => log.error('loadPlaylistIntoTray: explorer fetch failed', err));
    }

    return loaded;
}

/**
 * Show playlist picker overlay
 */
let _pickerEl = null;
let _pickerTree = null; // cached { folders, playlists }
let _pickerOnKey = null;

function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderPickerFolder(folderId) {
    if (!_pickerTree || !_pickerEl) return;

    const { folders, playlists } = _pickerTree;

    // Items in this folder
    const childFolders = folders.filter(f =>
        folderId === null ? !f.parent_id : f.parent_id === folderId
    );
    const childPlaylists = playlists.filter(p =>
        folderId === null ? !p.folder_id : p.folder_id === folderId
    );

    let html = '';

    // Parent navigation
    if (folderId !== null) {
        const current = folders.find(f => f.id === folderId);
        const parentId = current?.parent_id || null;
        html += `<div class="playlist-picker-item playlist-picker-back" data-folder-id="${parentId === null ? 'root' : parentId}">
            <span class="playlist-picker-name">..</span>
        </div>`;
    }

    // Folders
    for (const f of childFolders) {
        const count = playlists.filter(p => p.folder_id === f.id).length;
        html += `<div class="playlist-picker-item playlist-picker-folder" data-folder-nav="${f.id}">
            <span class="playlist-picker-name">${esc(f.name)}</span>
            <span class="playlist-picker-count">${count}</span>
        </div>`;
    }

    // Playlists
    for (const p of childPlaylists) {
        html += `<div class="playlist-picker-item" data-id="${p.id}">
            <span class="playlist-picker-name">${esc(p.name)}</span>
            <span class="playlist-picker-count">${p.track_count}</span>
        </div>`;
    }

    const list = _pickerEl.querySelector('.playlist-picker-list');
    if (list) list.innerHTML = html;
}

function closePicker() {
    if (_pickerEl?.isConnected) _pickerEl.remove();
    _pickerEl = null;
    _pickerTree = null;
    if (_pickerOnKey) {
        document.removeEventListener('keydown', _pickerOnKey, true);
        _pickerOnKey = null;
    }
}

export async function showPlaylistPicker() {
    // Close if already open
    if (_pickerEl && _pickerEl.isConnected) {
        closePicker();
        return;
    }

    const res = await fetch('/api/playlist-tree');
    if (!res.ok) {
        log.error('showPlaylistPicker: failed to fetch playlist tree');
        return;
    }

    _pickerTree = await res.json();
    if (_pickerTree.playlists.length === 0 && _pickerTree.folders.length === 0) {
        log.info('showPlaylistPicker: no playlists');
        _pickerTree = null;
        return;
    }

    _pickerEl = document.createElement('div');
    _pickerEl.className = 'playlist-picker';
    _pickerEl.innerHTML = `<div class="playlist-picker-list"></div>`;

    // Render root level
    renderPickerFolder(null);

    // Click handler — folders navigate, playlists load, backdrop closes
    _pickerEl.addEventListener('click', async (e) => {
        // Navigate into folder
        const folderNav = e.target.closest('[data-folder-nav]');
        if (folderNav) {
            renderPickerFolder(parseInt(folderNav.dataset.folderNav, 10));
            return;
        }

        // Navigate back
        const back = e.target.closest('.playlist-picker-back');
        if (back) {
            const parentId = back.dataset.folderId === 'root' ? null : parseInt(back.dataset.folderId, 10);
            renderPickerFolder(parentId);
            return;
        }

        // Select playlist
        const item = e.target.closest('[data-id]');
        if (item) {
            const id = parseInt(item.dataset.id, 10);
            closePicker();
            await loadPlaylistIntoTray(id);
            return;
        }

        // Click on backdrop
        if (e.target === _pickerEl) {
            closePicker();
        }
    });

    // Close on Escape
    _pickerOnKey = (e) => {
        if (e.key === 'Escape' && _pickerEl?.isConnected) {
            closePicker();
            e.stopPropagation();
        }
    };
    document.addEventListener('keydown', _pickerOnKey, true);

    document.body.appendChild(_pickerEl);
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.addToPlaylist = addToPlaylist;
    window.unwindPlaylist = unwindPlaylist;
    window.popPlaylistHead = popPlaylistHead;
    window.getPlaylistNext = getPlaylistNext;
    window.playlistHasItems = playlistHasItems;
    window.getPlaylistTail = getPlaylistTail;
    window.clearPlaylist = clearPlaylist;
    window.refreshExplorerForPlaylist = refreshExplorerForPlaylist;
    window.getLeftStack = getLeftStack;
    window.getRightStack = getRightStack;
    window.renderPlaylistTray = renderPlaylistTray;
    window.initPlaylistTray = initPlaylistTray;
    window.promoteCenterCardToTray = promoteCenterCardToTray;
    window.showTrackTooltip = showTrackTooltip;
    window.hideTrackTooltip = hideTrackTooltip;
    window.loadAlbumToTray = loadAlbumToTray;
    window.loadPlaylistIntoTray = loadPlaylistIntoTray;
    window.showPlaylistPicker = showPlaylistPicker;
}
