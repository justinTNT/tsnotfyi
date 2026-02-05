#!/usr/bin/env python3
"""
Analyze drift session logs to verify track transitions moved in the claimed direction.

Extracts track transitions from server logs and checks whether each step's
feature delta matches the claimed direction (e.g. "faster" → bpm increased).

Usage:
    python3 tools/analyze-session.py
    python3 tools/analyze-session.py --session session_105055bf
    python3 tools/analyze-session.py --server-log logs/server/2026-01-31_031329.log
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Direction mapping (parsed from kd-tree.js or hardcoded fallback)
# ---------------------------------------------------------------------------

DIRECTION_MAP_FALLBACK = {
    'faster': ('bpm', 'positive'),
    'slower': ('bpm', 'negative'),
    'more_danceable': ('danceability', 'positive'),
    'less_danceable': ('danceability', 'negative'),
    'busier_onsets': ('onset_rate', 'positive'),
    'sparser_onsets': ('onset_rate', 'negative'),
    'punchier_beats': ('beat_punch', 'positive'),
    'smoother_beats': ('beat_punch', 'negative'),
    'more_tonal': ('tonal_clarity', 'positive'),
    'more_atonal': ('tonal_clarity', 'negative'),
    'purer_tuning': ('tuning_purity', 'positive'),
    'looser_tuning': ('tuning_purity', 'negative'),
    'stronger_fifths': ('fifths_strength', 'positive'),
    'weaker_fifths': ('fifths_strength', 'negative'),
    'stronger_chords': ('chord_strength', 'positive'),
    'weaker_chords': ('chord_strength', 'negative'),
    'faster_changes': ('chord_change_rate', 'positive'),
    'slower_changes': ('chord_change_rate', 'negative'),
    'more_punchy': ('crest', 'positive'),
    'smoother': ('crest', 'negative'),
    'more_complex': ('entropy', 'positive'),
    'simpler': ('entropy', 'negative'),
    'brighter': ('spectral_centroid', 'positive'),
    'darker': ('spectral_centroid', 'negative'),
    'fuller_spectrum': ('spectral_rolloff', 'positive'),
    'narrower_spectrum': ('spectral_rolloff', 'negative'),
    'peakier_spectrum': ('spectral_kurtosis', 'positive'),
    'flatter_spectrum': ('spectral_kurtosis', 'negative'),
    'more_energetic': ('spectral_energy', 'positive'),
    'calmer': ('spectral_energy', 'negative'),
    'noisier': ('spectral_flatness', 'positive'),
    'more_tonal_spectrum': ('spectral_flatness', 'negative'),
    'more_bass': ('sub_drive', 'positive'),
    'less_bass': ('sub_drive', 'negative'),
    'more_air': ('air_sizzle', 'positive'),
    'less_air': ('air_sizzle', 'negative'),
    # legacy
    'denser_onsets': ('onset_rate', 'positive'),
    'impurer_tuning': ('tuning_purity', 'negative'),
    'less_punchy': ('crest', 'negative'),
    'more_air_sizzle': ('air_sizzle', 'positive'),
    'less_air_sizzle': ('air_sizzle', 'negative'),
}

# Positive direction aliases (from kd-tree.js isInDirection)
POSITIVE_ALIASES = {
    'faster', 'brighter', 'more_energetic', 'more_danceable', 'more_tonal',
    'more_complex', 'more_punchy', 'denser_onsets', 'purer_tuning',
    'stronger_chords', 'more_air_sizzle',
    'busier_onsets', 'punchier_beats', 'stronger_fifths', 'faster_changes',
    'fuller_spectrum', 'peakier_spectrum', 'noisier', 'more_bass', 'more_air',
}


def parse_kd_tree_directions(project_root):
    """Try to parse direction mappings from kd-tree.js source."""
    kd_path = project_root / 'kd-tree.js'
    if not kd_path.exists():
        return None

    src = kd_path.read_text()

    # Extract getDirectionDimension method body
    m = re.search(r'getDirectionDimension\s*\(.*?\)\s*\{(.*?)\n\s{4}\}', src, re.DOTALL)
    if not m:
        return None

    body = m.group(1)
    mapping = {}
    for alias, feature in re.findall(r"'(\w+)'\s*:\s*'(\w+)'", body):
        polarity = 'positive' if alias in POSITIVE_ALIASES else 'negative'
        mapping[alias] = (feature, polarity)

    return mapping if mapping else None


def resolve_direction(direction_key, direction_map):
    """
    Resolve a direction key to (feature, polarity).

    Handles:
      1. Alias lookup (e.g. "faster" → bpm, positive)
      2. {feature}_{positive|negative} raw keys
      3. {domain}_pc{n}_{polarity} PCA directions
      4. vae_latent_{n}_{polarity} VAE directions
    """
    if not direction_key:
        return None, None, None

    # 1. Alias lookup
    if direction_key in direction_map:
        feature, polarity = direction_map[direction_key]
        return feature, polarity, 'features'

    # 2. {feature}_{positive|negative}
    m = re.match(r'^(.+)_(positive|negative)$', direction_key)
    if m:
        feature, polarity = m.group(1), m.group(2)
        # Check if it's a PCA direction: {domain}_pc{n}
        pca_m = re.match(r'^(\w+)_pc(\d+)$', feature)
        if pca_m:
            domain, pc_idx = pca_m.group(1), int(pca_m.group(2))
            return f'{domain}_pc{pc_idx}', polarity, 'pca'

        # VAE latent: vae_latent_{n}
        vae_m = re.match(r'^vae_latent_(\d+)$', feature)
        if vae_m:
            return feature, polarity, 'vae'

        return feature, polarity, 'features'

    return None, None, None


def get_feature_value(track_data, feature, source):
    """Extract a feature value from track data given source type."""
    if source == 'features':
        features = track_data.get('features') or {}
        return features.get(feature)
    elif source == 'pca':
        pca = track_data.get('pca') or {}
        # PCA features like tonal_pc0 → pca.tonal[0]
        m = re.match(r'^(\w+)_pc(\d+)$', feature)
        if m:
            domain, idx = m.group(1), int(m.group(2))
            arr = pca.get(domain)
            if isinstance(arr, list) and idx < len(arr):
                return arr[idx]
        return None
    elif source == 'vae':
        features = track_data.get('features') or {}
        return features.get(feature)
    return None


# ---------------------------------------------------------------------------
# Log parsing
# ---------------------------------------------------------------------------

def find_latest_log(log_dir):
    """Find the most recently modified log file in a directory."""
    if not log_dir.is_dir():
        return None
    logs = sorted(log_dir.glob('*.log'), key=lambda p: p.stat().st_mtime, reverse=True)
    return logs[0] if logs else None


def parse_structured_transitions(server_log_path):
    """Primary strategy: extract track_transition JSON lines."""
    transitions = {}  # session_id → [transition, ...]

    with open(server_log_path) as f:
        for line in f:
            # The structured log may be embedded in the logger's JSON wrapper
            # or may be a raw console.log line
            try:
                obj = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            # Case 1: raw JSON.stringify output (direct console.log)
            if obj.get('_type') == 'track_transition':
                sid = obj.get('sessionId', 'unknown')
                transitions.setdefault(sid, []).append(obj)
                continue

            # Case 2: wrapped in logger format — the JSON is inside .message
            msg = obj.get('message', '')
            if '"_type":"track_transition"' in msg or '"_type": "track_transition"' in msg:
                try:
                    inner = json.loads(msg)
                    if inner.get('_type') == 'track_transition':
                        sid = inner.get('sessionId', 'unknown')
                        transitions.setdefault(sid, []).append(inner)
                except json.JSONDecodeError:
                    pass

    return transitions


def parse_fallback_transitions(server_log_path, client_log_path=None):
    """
    Fallback strategy: cross-reference 'Next track selected' and
    'Added to session history' log messages.
    """
    transitions = {}  # session_id → [transition_dict, ...]

    # Track which session is active — we infer from "Created drift audio mixer for session"
    current_session = None
    pending_direction = None  # most recent "Next track selected" direction

    # We also need features. Collect from client heartbeats keyed by (session_id, track_title).
    track_features = {}  # (session_id, title) → {features, pca}
    if client_log_path and Path(client_log_path).exists():
        track_features = _parse_client_features(client_log_path)

    with open(server_log_path) as f:
        for line in f:
            try:
                obj = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            msg = obj.get('message', '')
            ts = obj.get('timestamp', '')

            # Detect session creation
            m = re.search(r'Created drift audio mixer for session:\s*(session_\w+)', msg)
            if m:
                current_session = m.group(1)
                pending_direction = None
                continue

            # Detect session from "Adding client to drift session"
            m = re.search(r'Adding client to drift session:\s*(session_\w+)', msg)
            if m:
                current_session = m.group(1)
                continue

            # Detect direction from "Next track selected"
            m = re.search(
                r"Next track selected from direction '(\w+)'\s*\[(\w+)\]",
                msg
            )
            if m:
                pending_direction = m.group(2)  # e.g. "bpm_positive"
                continue

            # Detect track addition
            m = re.search(r'Added to session history:\s*(.+?)\s*\((\d+) total\)', msg)
            if m and current_session:
                title = m.group(1)
                seq = int(m.group(2))

                # Look up features from client heartbeats
                key = (current_session, title)
                feat_data = track_features.get(key, {})

                entry = {
                    '_type': 'track_transition',
                    'ts': ts,
                    'sessionId': current_session,
                    'seq': seq,
                    'track': {
                        'id': None,
                        'title': title,
                        'artist': None,
                        'features': feat_data.get('features'),
                        'pca': feat_data.get('pca'),
                    },
                    'prev': None,  # filled in post-processing
                    'direction': pending_direction if seq > 1 else None,
                    'transitionReason': 'fallback_parse',
                }

                transitions.setdefault(current_session, []).append(entry)
                pending_direction = None

    # Post-process: fill in prev features
    for sid, entries in transitions.items():
        entries.sort(key=lambda e: e['seq'])
        for i in range(1, len(entries)):
            prev_track = entries[i - 1]['track']
            entries[i]['prev'] = {
                'id': prev_track.get('id'),
                'features': prev_track.get('features'),
            }

    return transitions


def _parse_client_features(client_log_path):
    """Parse client log heartbeats to extract track features."""
    features = {}  # (session_id, title) → {features, pca}

    with open(client_log_path) as f:
        for line in f:
            try:
                obj = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            sid = obj.get('sessionId')
            msg = obj.get('message', '')

            if 'heartbeat' not in msg:
                continue

            # The heartbeat payload is in the message string or fragments
            fragments = obj.get('fragments', [])
            heartbeat = None

            for frag in fragments:
                if not isinstance(frag, str):
                    continue
                # Strip the leading "↳ " if present
                cleaned = frag.lstrip('↳ ').strip()
                try:
                    heartbeat = json.loads(cleaned)
                    break
                except json.JSONDecodeError:
                    continue

            if not heartbeat:
                # Try parsing from message
                m = re.search(r'heartbeat\s+(\{.*)', msg)
                if m:
                    try:
                        heartbeat = json.loads(m.group(1))
                    except json.JSONDecodeError:
                        pass

            if not heartbeat or not sid:
                continue

            ct = heartbeat.get('currentTrack', {})
            title = ct.get('title')
            if not title:
                continue

            key = (sid, title)
            if key not in features:
                features[key] = {
                    'features': ct.get('features'),
                    'pca': ct.get('pca'),
                }

    return features


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

MARGINAL_THRESHOLD = 0.10  # 10% of observed range is "marginal"


def analyze_transitions(entries, direction_map):
    """Analyze a list of transition entries and produce results."""
    results = []

    # Collect all feature values to compute ranges for marginal threshold
    all_values = {}  # feature → [values]
    for e in entries:
        track = e.get('track', {})
        feats = track.get('features') or {}
        for k, v in feats.items():
            if isinstance(v, (int, float)):
                all_values.setdefault(k, []).append(v)
        prev = e.get('prev') or {}
        prev_feats = prev.get('features') or {}
        for k, v in prev_feats.items():
            if isinstance(v, (int, float)):
                all_values.setdefault(k, []).append(v)

    feature_ranges = {}
    for feat, vals in all_values.items():
        if len(vals) >= 2:
            feature_ranges[feat] = max(vals) - min(vals)

    for i, entry in enumerate(entries):
        direction_key = entry.get('direction')
        track = entry.get('track', {})
        prev = entry.get('prev')
        neighborhood = entry.get('neighborhood') or {}

        row = {
            'seq': entry.get('seq', i + 1),
            'title': track.get('title', '?'),
            'artist': track.get('artist'),
            'direction_key': direction_key,
            'feature': None,
            'prev_val': None,
            'curr_val': None,
            'delta': None,
            'nbhd_radius': neighborhood.get('radius'),
            'nbhd_count': neighborhood.get('count'),
            'verdict': '—',
        }

        if not direction_key or not prev:
            row['direction_key'] = row['direction_key'] or '(start)'
            results.append(row)
            continue

        feature, polarity, source = resolve_direction(direction_key, direction_map)

        if not feature:
            row['feature'] = 'unmapped'
            row['verdict'] = 'UNMAPPED'
            results.append(row)
            continue

        row['feature'] = feature

        # Get values
        prev_data = {'features': prev.get('features'), 'pca': prev.get('pca') if prev else None}
        curr_data = {'features': track.get('features'), 'pca': track.get('pca')}

        prev_val = get_feature_value(prev_data, feature, source)
        curr_val = get_feature_value(curr_data, feature, source)

        row['prev_val'] = prev_val
        row['curr_val'] = curr_val

        if prev_val is None or curr_val is None:
            row['verdict'] = 'NO_DATA'
            results.append(row)
            continue

        delta = curr_val - prev_val
        row['delta'] = delta

        # Check direction
        expected_positive = (polarity == 'positive')
        correct = (delta > 0) if expected_positive else (delta < 0)

        # Check marginal
        feat_range = feature_ranges.get(feature, 0)
        marginal_thresh = feat_range * MARGINAL_THRESHOLD if feat_range > 0 else 0

        if correct:
            row['verdict'] = 'PASS'
        elif abs(delta) <= marginal_thresh:
            row['verdict'] = 'MARGINAL'
        else:
            row['verdict'] = 'FAIL'

        results.append(row)

    return results


def format_markdown(session_id, results, date_str=None):
    """Format analysis results as a markdown table."""
    total_transitions = sum(1 for r in results if r['direction_key'] != '(start)')
    date_part = f' ({date_str})' if date_str else ''

    lines = []
    lines.append(f'## Session: {session_id}{date_part}')
    lines.append(f'{len(results)} tracks, {total_transitions} transitions')
    lines.append('')
    lines.append('| # | Track | Direction | Feature | Prev | Curr | Delta | Nbhd | Verdict |')
    lines.append('|---|-------|-----------|---------|------|------|-------|------|---------|')

    for r in results:
        seq = r['seq']
        title = r['title'][:30] if r['title'] else '?'
        direction = r['direction_key'] or '—'
        feature = r['feature'] or '—'

        def fmt_val(v):
            if v is None:
                return '—'
            return f'{v:.3f}' if isinstance(v, float) else str(v)

        prev = fmt_val(r['prev_val'])
        curr = fmt_val(r['curr_val'])

        if r['delta'] is not None:
            delta = f'{r["delta"]:+.3f}'
        else:
            delta = '—'

        nbhd = '—'
        if r.get('nbhd_radius') is not None:
            nbhd = f'r={r["nbhd_radius"]:.2f} n={r["nbhd_count"]}'
        elif r.get('nbhd_count') is not None:
            nbhd = f'n={r["nbhd_count"]}'

        verdict = r['verdict']

        lines.append(f'| {seq} | {title} | {direction} | {feature} | {prev} | {curr} | {delta} | {nbhd} | {verdict} |')

    # Summary
    pass_count = sum(1 for r in results if r['verdict'] == 'PASS')
    marginal_count = sum(1 for r in results if r['verdict'] == 'MARGINAL')
    fail_count = sum(1 for r in results if r['verdict'] == 'FAIL')
    no_data_count = sum(1 for r in results if r['verdict'] == 'NO_DATA')
    unmapped_count = sum(1 for r in results if r['verdict'] == 'UNMAPPED')

    lines.append('')
    summary_parts = [f'{pass_count}/{total_transitions} PASS']
    summary_parts.append(f'{marginal_count}/{total_transitions} MARGINAL')
    summary_parts.append(f'{fail_count}/{total_transitions} FAIL')
    if no_data_count:
        summary_parts.append(f'{no_data_count} NO_DATA')
    if unmapped_count:
        summary_parts.append(f'{unmapped_count} UNMAPPED')
    lines.append(f'Summary: {", ".join(summary_parts)}')

    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Analyze drift session track transitions')
    parser.add_argument('--server-log', help='Path to server log file')
    parser.add_argument('--client-log', help='Path to client log file')
    parser.add_argument('--session', help='Session ID to analyze (default: session with most tracks)')
    args = parser.parse_args()

    # Find project root (script lives in tools/)
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent

    # Resolve log paths
    server_log = Path(args.server_log) if args.server_log else find_latest_log(project_root / 'logs' / 'server')
    client_log = Path(args.client_log) if args.client_log else find_latest_log(project_root / 'logs' / 'client')

    if not server_log or not server_log.exists():
        print('Error: No server log found. Use --server-log PATH.', file=sys.stderr)
        sys.exit(1)

    print(f'Server log: {server_log}', file=sys.stderr)
    if client_log and client_log.exists():
        print(f'Client log: {client_log}', file=sys.stderr)

    # Parse direction map from kd-tree.js (fall back to hardcoded)
    direction_map = parse_kd_tree_directions(project_root) or DIRECTION_MAP_FALLBACK

    # Try primary strategy (structured logs)
    transitions = parse_structured_transitions(server_log)

    strategy = 'structured'
    if not transitions:
        strategy = 'fallback'
        print('No structured track_transition lines found, using fallback parser...', file=sys.stderr)
        transitions = parse_fallback_transitions(server_log, client_log)

    if not transitions:
        print('Error: No transitions found in log.', file=sys.stderr)
        sys.exit(1)

    print(f'Strategy: {strategy}', file=sys.stderr)
    print(f'Sessions found: {", ".join(transitions.keys())} ({sum(len(v) for v in transitions.values())} total tracks)', file=sys.stderr)

    # Select session
    if args.session:
        session_id = args.session
        if session_id not in transitions:
            print(f'Error: Session {session_id} not found. Available: {", ".join(transitions.keys())}', file=sys.stderr)
            sys.exit(1)
    else:
        # Pick session with most tracks
        session_id = max(transitions, key=lambda k: len(transitions[k]))

    entries = transitions[session_id]
    entries.sort(key=lambda e: e.get('seq', 0))

    print(f'Analyzing session: {session_id} ({len(entries)} tracks)', file=sys.stderr)
    print('', file=sys.stderr)

    # Extract date from first entry
    date_str = None
    if entries:
        ts = entries[0].get('ts', '')
        if ts:
            date_str = ts[:10]

    results = analyze_transitions(entries, direction_map)
    print(format_markdown(session_id, results, date_str))


if __name__ == '__main__':
    main()
