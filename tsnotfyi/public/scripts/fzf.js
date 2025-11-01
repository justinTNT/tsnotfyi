// ====== Fuzzy Search (fzf) Interface ======

let fzfState = {
    isVisible: false,
    currentResults: [],
    selectedIndex: 0,
    searchTimeout: null
};

let onExit = null;

// Set up fuzzy search interface
function setupFzfSearch(cleanupCallback) {
    onExit = cleanupCallback;
    const fzfSearch = document.getElementById('fzfSearch');
    const fzfInput = document.getElementById('fzfInput');
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfSearch || !fzfInput || !fzfResults) {
        console.warn('🔍 Fuzzy search elements not found in DOM');
        return;
    }

    // Global keyboard shortcut to open fzf (Ctrl+K or Cmd+K)
    document.addEventListener('keydown', (e) => {
        // Open fzf with Ctrl+K or Cmd+K
        if ((e.ctrlKey || e.metaKey) && e.key === 'k' && !fzfState.isVisible) {
            e.preventDefault();
            openFzfSearch();
        }

        // Close fzf with Escape
        if (e.key === 'Escape' && fzfState.isVisible) {
            e.preventDefault();
            closeFzfSearch();
        }
    });

    // Input event listener for real-time search
    fzfInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();

        // Clear previous timeout
        if (fzfState.searchTimeout) {
            clearTimeout(fzfState.searchTimeout);
        }

        // Debounce search requests
        fzfState.searchTimeout = setTimeout(() => {
            if (query.length >= 2) {
                performFzfSearch(query);
            } else {
                clearFzfResults();
            }
        }, 300);
    });

    // Keyboard navigation in fzf
    fzfInput.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                navigateFzf(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                navigateFzf(-1);
                break;
            case 'Enter':
                e.preventDefault();
                selectFzfResult();
                break;
            case 'Escape':
                e.preventDefault();
                closeFzfSearch();
                break;
        }
    });

    // Click outside to close
    fzfSearch.addEventListener('click', (e) => {
        if (e.target === fzfSearch) {
            closeFzfSearch();
        }
    });

    console.log('🔍 Fuzzy search interface set up (Ctrl+K to open)');

    // Set up search icon click handler
    const searchIcon = document.getElementById('searchIcon');
    if (searchIcon) {
        searchIcon.addEventListener('click', () => {
            if (!fzfState.isVisible) {
                openFzfSearch();
            }
        });
        console.log('🔍 Search icon click handler set up');
    }
}

// Open fuzzy search interface
function openFzfSearch() {
    const fzfSearch = document.getElementById('fzfSearch');
    const fzfInput = document.getElementById('fzfInput');

    if (fzfSearch && fzfInput) {
        fzfState.isVisible = true;
        fzfSearch.classList.remove('hidden');
        state.journeyMode = false;

        // Focus input and clear previous search
        fzfInput.value = '';
        fzfInput.focus();

        clearFzfResults();

        console.log('🔍 Opened fuzzy search interface');
    }
}

// Close fuzzy search interface
function closeFzfSearch() {
    const fzfSearch = document.getElementById('fzfSearch');

    if (fzfSearch) {
        fzfState.isVisible = false;
        fzfSearch.classList.add('hidden');

        // Clear search state
        fzfState.currentResults = [];
        fzfState.selectedIndex = 0;

        if (fzfState.searchTimeout) {
            clearTimeout(fzfState.searchTimeout);
            fzfState.searchTimeout = null;
        }

        console.log('🔍 Closed fuzzy search interface');
    }

   if (typeof onExit === 'function') {
       onExit();
   }
}

// Perform fuzzy search request
async function performFzfSearch(query) {
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfResults) return;

    // Show loading state
    fzfResults.innerHTML = '<div class="fzf-loading">Searching...</div>';

    try {
        console.log(`🔍 Searching for: "${query}"`);

        const response = await fetch(`/search?q=${encodeURIComponent(query)}&limit=20`);

        if (!response.ok) {
            throw new Error(`Search failed: ${response.statusText}`);
        }

        const data = await response.json();

        console.log(`🔍 Found ${data.results.length} results for "${query}"`);

        fzfState.currentResults = data.results;
        fzfState.selectedIndex = 0;

        renderFzfResults();

    } catch (error) {
        console.error('🔍 Search error:', error);
        fzfResults.innerHTML = '<div class="fzf-no-results">Search failed. Please try again.</div>';
    }
}

// Render search results
function renderFzfResults() {
    const fzfResults = document.getElementById('fzfResults');

    if (!fzfResults) return;

    if (fzfState.currentResults.length === 0) {
        fzfResults.innerHTML = '<div class="fzf-no-results">No tracks found</div>';
        return;
    }

    const resultsHtml = fzfState.currentResults.map((result, index) => {
        const isSelected = index === fzfState.selectedIndex;
        const selectedClass = isSelected ? 'selected' : '';

        return `
            <div class="fzf-result-item ${selectedClass}" data-index="${index}">
                <div class="fzf-result-primary">${result.displayText || `${result.artist} - ${result.title}`}</div>
                <div class="fzf-result-secondary">${result.album || ''} ${result.year ? `(${result.year})` : ''}</div>
                <div class="fzf-result-meta">${result.identifier}</div>
            </div>
        `;
    }).join('');

    fzfResults.innerHTML = resultsHtml;

    // Add click handlers to results
    fzfResults.querySelectorAll('.fzf-result-item').forEach((item, index) => {
        item.addEventListener('click', () => {
            fzfState.selectedIndex = index;
            selectFzfResult();
        });
    });

    // Scroll selected item into view
    scrollSelectedIntoView();
}

// Navigate through search results
function navigateFzf(direction) {
    if (fzfState.currentResults.length === 0) return;

    fzfState.selectedIndex += direction;

    // Wrap around
    if (fzfState.selectedIndex < 0) {
        fzfState.selectedIndex = fzfState.currentResults.length - 1;
    } else if (fzfState.selectedIndex >= fzfState.currentResults.length) {
        fzfState.selectedIndex = 0;
    }

    // Update visual selection
    const fzfResults = document.getElementById('fzfResults');
    if (fzfResults) {
        fzfResults.querySelectorAll('.fzf-result-item').forEach((item, index) => {
            item.classList.toggle('selected', index === fzfState.selectedIndex);
        });

        scrollSelectedIntoView();
    }
}

// Scroll selected item into view
function scrollSelectedIntoView() {
    const selectedItem = document.querySelector('.fzf-result-item.selected');
    if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

// Select current result and jump to track
async function selectFzfResult() {
    if (fzfState.currentResults.length === 0 || fzfState.selectedIndex < 0) return;

    const selectedResult = fzfState.currentResults[fzfState.selectedIndex];

    if (selectedResult) {
        const trackId =
            selectedResult.identifier ||
            selectedResult.trackMd5 ||
            selectedResult.md5 ||
            selectedResult.id ||
            null;

        if (!trackId) {
            console.warn('🔍 Selected search result is missing an identifier', selectedResult);
            return;
        }

        console.log(`🔍 Selected track: ${selectedResult.displayText || 'Unknown'} (${trackId})`);

        // Jump to this track (use the SHA endpoint)
        try {
            await jumpToTrack(trackId, selectedResult);
        } catch (error) {
            console.error('🎯 Fuzzy jump failed:', error);
            showFzfError('Failed to queue track – see console');
            return;
        }

        // Close fzf interface
        closeFzfSearch();
    }
}

// Jump to a specific track by MD5
async function jumpToTrack(trackMd5, metadata = {}) {
    if (!trackMd5) {
        console.warn('🎯 jumpToTrack called without a track ID');
        return;
    }

    try {
        console.log(`🎯 Jumping to track: ${trackMd5}`);

        if (typeof window.sendNextTrack === 'function') {
            if (window.state) {
                window.state.suppressPreviewTrackId = trackMd5;
            }
            if (typeof window.hideNextTrackPreview === 'function') {
                window.hideNextTrackPreview({ immediate: true });
            }
            const preferredDirection = metadata.directionKey || metadata.direction || null;
            await window.sendNextTrack(trackMd5, preferredDirection, {
                source: 'user',
                origin: 'fzf-search'
            });
        } else {
            console.warn('🎯 sendNextTrack not available; falling back to page navigation');
            window.location.href = `/${trackMd5}`;
        }

    } catch (error) {
        console.error('🎯 Failed to jump to track:', error);
        throw error;
    }
}

function showFzfError(message) {
    const fzfResults = document.getElementById('fzfResults');
    if (fzfResults) {
        fzfResults.innerHTML = `<div class="fzf-no-results">${message}</div>`;
    }
}

// Clear search results
function clearFzfResults() {
    const fzfResults = document.getElementById('fzfResults');
    if (fzfResults) {
        fzfResults.innerHTML = '<div class="fzf-no-results">...</div>';
    }

    fzfState.currentResults = [];
    fzfState.selectedIndex = 0;
}
