// Beets metadata UI - chip display for track metadata
// Dependencies: globals.js (elements)

import { elements } from './globals.js';

export function sanitizeChipValue(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        if (Math.abs(value) >= 10) {
            return Math.round(value).toString();
        }
        return value.toFixed(2).replace(/\.00$/, '');
    }
    return String(value).trim();
}

export function collectBeetsChips(meta) {
    if (!meta || typeof meta !== 'object') {
        return [];
    }

    const chips = [];
    const seen = new Set();
    const seenVals = new Set();

    const pushChip = (segmentKey, slotKey, rawValue) => {
        const segmentText = sanitizeChipValue(segmentKey) || 'segment';
        const valueText = sanitizeChipValue(rawValue);

        if (!segmentText || !valueText || valueText === '' || valueText === '0') return;

        const normalizedValue = valueText.toLowerCase().split('/').join('\n');
        if (seenVals.has(valueText)) return;
        seenVals.add(valueText);

        const normalizedSlot = sanitizeChipValue(slotKey) || '';
        if (normalizedSlot.match(/path$/i)) return;

        const id = `${segmentText.toLowerCase()}|${normalizedSlot}|${normalizedValue}`;
        if (seen.has(id)) return;
        seen.add(id);

        const chipKey = normalizedSlot ? `${segmentText}:${normalizedSlot}` : segmentText;
        chips.push({ key: chipKey, value: valueText, priority: 0 });
    };

    Object.entries(meta).forEach(([segmentKey, segmentValue]) => {
        if (!segmentValue || typeof segmentValue !== 'object' || Array.isArray(segmentValue)) {
            return;
        }

        Object.entries(segmentValue).forEach(([slotKey, rawValue]) => {
            if (rawValue === null || rawValue === undefined) return;

            if (Array.isArray(rawValue)) {
                rawValue.forEach(entry => pushChip(segmentKey, slotKey, entry));
            } else if (typeof rawValue === 'object') {
                Object.entries(rawValue).forEach(([innerKey, innerValue]) => {
                    if (innerValue === null || innerValue === undefined) return;
                    const combinedKey = innerKey ? `${slotKey}.${innerKey}` : slotKey;
                    if (Array.isArray(innerValue)) {
                        innerValue.forEach(val => pushChip(segmentKey, combinedKey, val));
                    } else {
                        pushChip(segmentKey, combinedKey, innerValue);
                    }
                });
            } else {
                pushChip(segmentKey, slotKey, rawValue);
            }
        });
    });

    return chips;
}

export function renderBeetsSegments(track) {
    const container = elements.beetsSegments;
    if (!container) return;

    container.innerHTML = '';
    container.classList.remove('visible');
    container.classList.remove('hidden');

    const meta = track?.beetsMeta || track?.beets || null;
    const chips = collectBeetsChips(meta).slice(0, 21);

    if (chips.length === 0) {
        container.classList.add('hidden');
        container.dataset.hasData = 'false';
        return;
    }

    const fragment = document.createDocumentFragment();
    chips.forEach(({ key, value }) => {
        const chip = document.createElement('div');
        chip.className = 'beets-chip';
        chip.innerHTML = `
            <span class="chip-bracket">[</span>
            <span class="chip-value">${value}</span>
            <span class="chip-separator">:</span>
            <span class="chip-key">${key}</span>
            <span class="chip-bracket">]</span>
        `;
        fragment.appendChild(chip);
    });

    container.appendChild(fragment);
    container.classList.remove('hidden');
    container.dataset.hasData = 'true';
}

export function hideBeetsSegments() {
    if (!elements.beetsSegments) return;
    elements.beetsSegments.classList.remove('visible');
    elements.beetsSegments.classList.add('hidden');
}

// Expose globally for cross-module access
if (typeof window !== 'undefined') {
    window.sanitizeChipValue = sanitizeChipValue;
    window.collectBeetsChips = collectBeetsChips;
    window.renderBeetsSegments = renderBeetsSegments;
    window.hideBeetsSegments = hideBeetsSegments;
}
