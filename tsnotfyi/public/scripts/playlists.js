// Playlist management page
// VS Code sidebar-style tree with nested folders, inline rename, drag-and-drop, context menus

const CHEVRON_SVG = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4"/></svg>`;

// ==================== State ====================
const state = {
    folders: [],
    playlists: [],
    expandedFolders: new Set(),
    expandedPlaylists: new Set(),
    playlistTracks: {},  // playlistId -> tracks array (loaded on expand)
    renaming: null,      // { type, id }
    dragging: null,      // { type, id }
    unsavedSession: null  // { tracks }
};

// ==================== Data ====================

async function fetchTree() {
    const res = await fetch('/api/playlist-tree');
    if (!res.ok) return;
    const data = await res.json();
    state.folders = data.folders;
    state.playlists = data.playlists;
    render();
}

async function fetchPlaylistTracks(playlistId) {
    if (state.playlistTracks[playlistId]) return state.playlistTracks[playlistId];
    const res = await fetch(`/api/playlists/${playlistId}`);
    if (!res.ok) return [];
    const data = await res.json();
    state.playlistTracks[playlistId] = data.tracks;
    return data.tracks;
}

// ==================== Tree building ====================

function buildTree() {
    // Build folder tree
    const folderMap = {};
    for (const f of state.folders) {
        folderMap[f.id] = { ...f, type: 'folder', children: [], playlists: [] };
    }
    const rootFolders = [];
    for (const f of state.folders) {
        const node = folderMap[f.id];
        if (f.parent_id && folderMap[f.parent_id]) {
            folderMap[f.parent_id].children.push(node);
        } else {
            rootFolders.push(node);
        }
    }

    // Assign playlists to folders
    const rootPlaylists = [];
    for (const p of state.playlists) {
        const node = { ...p, type: 'playlist' };
        if (p.folder_id && folderMap[p.folder_id]) {
            folderMap[p.folder_id].playlists.push(node);
        } else {
            rootPlaylists.push(node);
        }
    }

    return { rootFolders, rootPlaylists };
}

// ==================== Rendering ====================

function render() {
    const container = document.getElementById('tree');
    const { rootFolders, rootPlaylists } = buildTree();

    let html = '';

    // Unsaved session
    if (state.unsavedSession) {
        html += renderUnsavedSession();
    }

    // Render root folders
    for (const folder of rootFolders) {
        html += renderFolder(folder, 0);
    }

    // Render root playlists
    for (const pl of rootPlaylists) {
        html += renderPlaylist(pl, 0);
    }

    container.innerHTML = html;
    attachHandlers();
}

function renderFolder(folder, depth) {
    const expanded = state.expandedFolders.has(folder.id);
    const chevronClass = expanded ? 'chevron expanded' : 'chevron';

    // Count total playlists in this folder subtree
    const count = countPlaylistsInFolder(folder);

    let html = `<div class="tree-row" data-type="folder" data-id="${folder.id}"
                     draggable="true" style="padding-left:${8 + depth * 20}px">
        <span class="${chevronClass}" data-toggle="folder" data-id="${folder.id}">${CHEVRON_SVG}</span>
        <span class="folder-icon">&#128193;</span>
        <span class="tree-name" data-type="folder" data-id="${folder.id}">${esc(folder.name)}</span>
        <span class="tree-count">${count}</span>
    </div>`;

    if (expanded) {
        html += `<div class="tree-children">`;
        for (const child of folder.children) {
            html += renderFolder(child, depth + 1);
        }
        for (const pl of folder.playlists) {
            html += renderPlaylist(pl, depth + 1);
        }
        html += `</div>`;
    }

    return html;
}

function renderPlaylist(pl, depth) {
    const expanded = state.expandedPlaylists.has(pl.id);

    // Cover strip
    const covers = (pl.covers || []).slice(0, 4);
    let coverHtml = '';
    if (covers.length > 0) {
        coverHtml = `<div class="cover-strip">`;
        for (const src of covers) {
            coverHtml += `<img src="${esc(src)}" loading="lazy" />`;
        }
        coverHtml += `</div>`;
    }

    const chevronClass = expanded ? 'chevron expanded' : 'chevron';
    const hasToggle = pl.track_count > 0;

    let html = `<div class="tree-row" data-type="playlist" data-id="${pl.id}"
                     draggable="true" style="padding-left:${8 + depth * 20}px">
        ${hasToggle
            ? `<span class="${chevronClass}" data-toggle="playlist" data-id="${pl.id}">${CHEVRON_SVG}</span>`
            : `<span class="chevron-spacer"></span>`}
        ${coverHtml}
        <span class="tree-name" data-type="playlist" data-id="${pl.id}">${esc(pl.name)}</span>
        <span class="tree-count">${pl.track_count}</span>
    </div>`;

    if (expanded && state.playlistTracks[pl.id]) {
        html += renderTracklist(state.playlistTracks[pl.id]);
    }

    return html;
}

const PASTEL_COLORS = [
    '#ffaaaa', '#aaffaa', '#aaaaff',
    '#ffffaa', '#aaffff', '#ffaaff',
    '#cccccc',
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

function renderTracklist(tracks) {
    let html = `<div class="tracklist">`;
    for (const t of tracks) {
        const cover = t.albumCover || '/images/albumcover.png';
        const isDefault = !t.albumCover || t.albumCover === '/images/albumcover.png';
        const label = isDefault ? monthFromPath(t.path) : '';
        if (label) {
            html += `<div class="track-row">
                <div class="track-cover-wrap">
                    <img class="track-cover" src="${esc(cover)}" loading="lazy" />
                    <span class="track-cover-label" style="color:${pastelFromString(label)}">${esc(label)}</span>
                </div>
                <span class="track-title">${esc(t.title || 'Unknown')}</span>
                <span class="track-artist">${esc(t.artist || '')}</span>
            </div>`;
        } else {
            html += `<div class="track-row">
                <img class="track-cover" src="${esc(cover)}" loading="lazy" />
                <span class="track-title">${esc(t.title || 'Unknown')}</span>
                <span class="track-artist">${esc(t.artist || '')}</span>
            </div>`;
        }
    }
    html += `</div>`;
    return html;
}

function renderUnsavedSession() {
    const tracks = state.unsavedSession.tracks || [];
    return `<div class="unsaved-session">
        <div>Unsaved session &mdash; ${tracks.length} tracks</div>
        <div class="save-row">
            <input id="sessionName" type="text" placeholder="Playlist name..." autofocus />
            <button id="btnSaveSession">Save</button>
        </div>
    </div>`;
}

function countPlaylistsInFolder(folder) {
    let n = folder.playlists?.length || 0;
    for (const child of folder.children || []) {
        n += countPlaylistsInFolder(child);
    }
    return n;
}

function esc(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ==================== Event handlers ====================

function attachHandlers() {
    const container = document.getElementById('tree');

    // Toggle expand/collapse
    container.querySelectorAll('[data-toggle]').forEach(el => {
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            const type = el.dataset.toggle;
            const id = parseInt(el.dataset.id);
            if (type === 'folder') {
                if (state.expandedFolders.has(id)) state.expandedFolders.delete(id);
                else state.expandedFolders.add(id);
                render();
            } else if (type === 'playlist') {
                if (state.expandedPlaylists.has(id)) {
                    state.expandedPlaylists.delete(id);
                    render();
                } else {
                    state.expandedPlaylists.add(id);
                    await fetchPlaylistTracks(id);
                    render();
                }
            }
        });
    });

    // Row click = toggle for folders, expand for playlists
    container.querySelectorAll('.tree-row').forEach(el => {
        el.addEventListener('click', async () => {
            const type = el.dataset.type;
            const id = parseInt(el.dataset.id);
            if (type === 'folder') {
                if (state.expandedFolders.has(id)) state.expandedFolders.delete(id);
                else state.expandedFolders.add(id);
                render();
            } else if (type === 'playlist') {
                if (state.expandedPlaylists.has(id)) {
                    state.expandedPlaylists.delete(id);
                    render();
                } else {
                    state.expandedPlaylists.add(id);
                    await fetchPlaylistTracks(id);
                    render();
                }
            }
        });

        // Double-click to rename
        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            startRename(el.dataset.type, parseInt(el.dataset.id));
        });

        // Context menu
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showContextMenu(e, el.dataset.type, parseInt(el.dataset.id));
        });

        // Drag and drop
        el.addEventListener('dragstart', (e) => {
            state.dragging = { type: el.dataset.type, id: parseInt(el.dataset.id) };
            e.dataTransfer.effectAllowed = 'move';
            el.style.opacity = '0.4';
        });

        el.addEventListener('dragend', () => {
            el.style.opacity = '';
            state.dragging = null;
            clearDropIndicators();
        });

        el.addEventListener('dragover', (e) => {
            if (!state.dragging) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            clearDropIndicators();

            // Only folders accept drops inside
            if (el.dataset.type === 'folder') {
                const rect = el.getBoundingClientRect();
                const y = e.clientY - rect.top;
                if (y < rect.height * 0.25) {
                    el.classList.add('drop-above');
                } else if (y > rect.height * 0.75) {
                    el.classList.add('drop-below');
                } else {
                    el.classList.add('drag-over');
                }
            } else {
                const rect = el.getBoundingClientRect();
                const y = e.clientY - rect.top;
                if (y < rect.height / 2) {
                    el.classList.add('drop-above');
                } else {
                    el.classList.add('drop-below');
                }
            }
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over', 'drop-above', 'drop-below');
        });

        el.addEventListener('drop', async (e) => {
            e.preventDefault();
            clearDropIndicators();
            if (!state.dragging) return;

            const src = state.dragging;
            const tgtType = el.dataset.type;
            const tgtId = parseInt(el.dataset.id);

            if (src.type === src.type && src.id === tgtId) return;

            // Determine target folder
            if (tgtType === 'folder' && el.classList.contains('drag-over')) {
                // Drop inside folder
                if (src.type === 'playlist') {
                    await fetch(`/api/playlists/${src.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ folder_id: tgtId })
                    });
                } else if (src.type === 'folder') {
                    await fetch(`/api/folders/${src.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ parent_id: tgtId })
                    });
                }
                state.expandedFolders.add(tgtId);
            } else {
                // Drop adjacent — move to same parent as target
                if (src.type === 'playlist') {
                    const tgtPlaylist = state.playlists.find(p => p.id === tgtId);
                    const folderId = tgtType === 'folder'
                        ? (state.folders.find(f => f.id === tgtId)?.parent_id || null)
                        : (tgtPlaylist?.folder_id || null);
                    await fetch(`/api/playlists/${src.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ folder_id: folderId })
                    });
                } else if (src.type === 'folder') {
                    const tgtFolder = state.folders.find(f => f.id === tgtId);
                    const parentId = tgtType === 'folder'
                        ? (tgtFolder?.parent_id || null)
                        : null;
                    await fetch(`/api/folders/${src.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ parent_id: parentId })
                    });
                }
            }

            state.dragging = null;
            await fetchTree();
        });
    });

    // Save session button
    const btnSave = document.getElementById('btnSaveSession');
    if (btnSave) {
        btnSave.addEventListener('click', saveUnsavedSession);
    }
    const sessionInput = document.getElementById('sessionName');
    if (sessionInput) {
        sessionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveUnsavedSession();
        });
    }
}

function clearDropIndicators() {
    document.querySelectorAll('.drag-over, .drop-above, .drop-below').forEach(el => {
        el.classList.remove('drag-over', 'drop-above', 'drop-below');
    });
}

// ==================== Rename ====================

function startRename(type, id) {
    state.renaming = { type, id };
    const nameEl = document.querySelector(`.tree-name[data-type="${type}"][data-id="${id}"]`);
    if (!nameEl) return;

    const current = nameEl.textContent;
    nameEl.innerHTML = `<input type="text" value="${esc(current)}" />`;
    const input = nameEl.querySelector('input');
    input.focus();
    input.select();

    const commit = async () => {
        const newName = input.value.trim();
        if (newName && newName !== current) {
            const endpoint = type === 'folder' ? `/api/folders/${id}` : `/api/playlists/${id}`;
            await fetch(endpoint, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });
            await fetchTree();
        } else {
            render();
        }
        state.renaming = null;
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { state.renaming = null; render(); }
        e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
}

// ==================== Context menu ====================

function showContextMenu(e, type, id) {
    const menu = document.getElementById('contextMenu');
    let items = [];

    if (type === 'folder') {
        items = [
            { label: 'Rename', action: () => startRename('folder', id) },
            { label: 'New subfolder', action: () => createFolder(id) },
            { sep: true },
            { label: 'Delete folder', danger: true, action: () => deleteFolder(id) }
        ];
    } else if (type === 'playlist') {
        // Build "Move to" submenu items
        const moveItems = [
            { label: '/ (root)', action: () => movePlaylist(id, null) },
            ...state.folders.map(f => ({
                label: f.name,
                action: () => movePlaylist(id, f.id)
            }))
        ];

        items = [
            { label: 'Rename', action: () => startRename('playlist', id) },
            { sep: true },
            ...moveItems.map(m => ({ label: `Move to ${m.label}`, action: m.action })),
            { sep: true },
            { label: 'Delete playlist', danger: true, action: () => deletePlaylist(id) }
        ];
    }

    menu.innerHTML = items.map(item => {
        if (item.sep) return `<div class="context-sep"></div>`;
        const cls = item.danger ? 'context-item danger' : 'context-item';
        return `<div class="${cls}">${esc(item.label)}</div>`;
    }).join('');

    // Attach click handlers
    const divs = menu.querySelectorAll('.context-item');
    let itemIdx = 0;
    for (const item of items) {
        if (item.sep) continue;
        const div = divs[itemIdx++];
        div.addEventListener('click', () => {
            hideContextMenu();
            item.action();
        });
    }

    menu.style.display = 'block';
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 10) + 'px';
}

function hideContextMenu() {
    document.getElementById('contextMenu').style.display = 'none';
}

// ==================== Actions ====================

async function createFolder(parentId = null) {
    const name = prompt('Folder name:');
    if (!name) return;
    await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parent_id: parentId })
    });
    if (parentId) state.expandedFolders.add(parentId);
    await fetchTree();
}

async function deleteFolder(id) {
    if (!confirm('Delete this folder? Playlists inside will move to root.')) return;
    await fetch(`/api/folders/${id}`, { method: 'DELETE' });
    state.expandedFolders.delete(id);
    await fetchTree();
}

async function deletePlaylist(id) {
    const pl = state.playlists.find(p => p.id === id);
    if (!confirm(`Delete "${pl?.name || 'this playlist'}"?`)) return;
    await fetch(`/api/playlists/${id}`, { method: 'DELETE' });
    state.expandedPlaylists.delete(id);
    delete state.playlistTracks[id];
    await fetchTree();
}

async function movePlaylist(id, folderId) {
    await fetch(`/api/playlists/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: folderId })
    });
    if (folderId) state.expandedFolders.add(folderId);
    await fetchTree();
}

async function saveUnsavedSession() {
    const input = document.getElementById('sessionName');
    const name = input?.value?.trim();
    if (!name) { input?.focus(); return; }

    const tracks = state.unsavedSession.tracks;

    // Create playlist
    const res = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
    });
    if (!res.ok) return;
    const playlist = await res.json();

    // Add tracks
    for (let i = 0; i < tracks.length; i++) {
        await fetch(`/api/playlists/${playlist.id}/tracks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                identifier: tracks[i].identifier,
                direction: tracks[i].direction || null,
                position: i
            })
        });
    }

    // Clear unsaved state and refresh
    state.unsavedSession = null;
    // Clean URL
    const url = new URL(window.location);
    url.searchParams.delete('session');
    window.history.replaceState({}, '', url);
    await fetchTree();
}

// ==================== Init ====================

function init() {
    // Check for unsaved session in URL
    const params = new URLSearchParams(window.location.search);
    const sessionParam = params.get('session');
    if (sessionParam) {
        try {
            state.unsavedSession = JSON.parse(atob(sessionParam));
        } catch (e) {
            console.error('Failed to decode session:', e);
        }
    }

    // Global click dismisses context menu
    document.addEventListener('click', hideContextMenu);

    // Escape dismisses context menu
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideContextMenu();
        if (e.key === 'F2') {
            // Rename selected/hovered item
            const hovered = document.querySelector('.tree-row:hover');
            if (hovered) {
                e.preventDefault();
                startRename(hovered.dataset.type, parseInt(hovered.dataset.id));
            }
        }
    });

    // New folder button
    document.getElementById('btnNewFolder')?.addEventListener('click', () => createFolder(null));

    fetchTree();
}

init();
