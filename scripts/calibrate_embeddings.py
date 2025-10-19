#!/usr/bin/env python3
"""Calibrate PCA/VAE neighborhood radii for the exploration services.

Usage examples:
    # Calibrate VAE latent space using defaults
    python scripts/calibrate_embeddings.py --mode vae --sample-centers 400

    # Calibrate PCA with custom sample size and random seed
    python scripts/calibrate_embeddings.py --mode pca --sample-centers 800 --seed 123
"""

import argparse
import hashlib
import json
import logging
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import numpy as np

try:
    import psycopg2
except ImportError as exc:  # pragma: no cover - runtime dependency guard
    raise SystemExit(
        "psycopg2 is required. Install with `pip install psycopg2-binary`."
    ) from exc


DEFAULT_RESOLUTION_PERCENTILES: Dict[str, Tuple[float, float]] = {
    'microscope': (0.02, 0.08),
    'magnifying_glass': (0.05, 0.20),
    'binoculars': (0.15, 0.40),
}

DEFAULT_PCA_DISCRIMINATORS: Tuple[str, ...] = (
    'primary_d', 'tonal', 'spectral', 'rhythmic'
)

DEFAULT_VAE_DISCRIMINATORS: Tuple[str, ...] = ('latent',)

MIN_EFFECTIVE_RADIUS = 1e-5
DEFAULT_VAE_FALLBACK_OUTER = 0.5
FALLBACK_PERCENTILE_PAIRS = [
    (0.20, 0.60),
    (0.30, 0.80),
    (0.40, 0.90),
    (0.50, 0.95)
]


@dataclass
class CalibrationRecord:
    mode: str
    resolution: str
    discriminator: str
    inner_radius: float
    outer_radius: float
    base_x: float
    target_percentage: float
    achieved_percentage: float
    library_size: int
    sample_size: int
    calibrated_at: datetime
    checksum: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Calibrate embedding neighborhood radii for PCA/VAE spaces'
    )
    parser.add_argument('--mode', choices=['pca', 'vae'], required=True,
                        help='Which embedding space to calibrate')
    parser.add_argument('--config', default='tsnotfyi-config.json',
                        help='Path to configuration file with Postgres connection string')
    parser.add_argument('--database-url', help='Explicit database URL overriding the config file')
    parser.add_argument('--sample-centers', type=int, default=400,
                        help='Number of random center tracks to sample (default: 400)')
    parser.add_argument('--neighbor-count', type=int, default=250,
                        help='How many nearest neighbors to inspect per center (default: 250)')
    parser.add_argument('--inner-percentile', type=float,
                        help='Override inner percentile (applies to all resolutions)')
    parser.add_argument('--outer-percentile', type=float,
                        help='Override outer percentile (applies to all resolutions)')
    parser.add_argument('--seed', type=int, default=42,
                        help='Random seed for reproducibility (default: 42)')
    parser.add_argument('--dry-run', action='store_true',
                        help='Compute calibration but do not write to the database')
    return parser.parse_args()


def load_config(path: str) -> Dict:
    if not os.path.exists(path):
        raise FileNotFoundError(f'Configuration file not found: {path}')
    with open(path, 'r', encoding='utf-8') as handle:
        return json.load(handle)


def resolve_database_url(args: argparse.Namespace) -> str:
    if args.database_url:
        return args.database_url
    config = load_config(args.config)
    try:
        return config['database']['postgresql']['connectionString']
    except KeyError as exc:
        raise KeyError('Unable to locate Postgres connection string in config file') from exc


def fetch_embedding_data(conn, mode: str) -> Dict[str, np.ndarray]:
    logging.info('Loading %s embedding data from database...', mode.upper())
    if mode == 'pca':
        columns = [
            'identifier',
            'primary_d',
            'tonal_pc1', 'tonal_pc2', 'tonal_pc3',
            'spectral_pc1', 'spectral_pc2', 'spectral_pc3',
            'rhythmic_pc1', 'rhythmic_pc2', 'rhythmic_pc3'
        ]
        where_clause = 'primary_d IS NOT NULL'
        required_cols = columns[1:]
    else:
        columns = ['identifier'] + [f'vae_latent_{i}' for i in range(8)]
        where_clause = ' AND '.join(f'vae_latent_{i} IS NOT NULL' for i in range(8))
        required_cols = columns[1:]

    query = f"SELECT {', '.join(columns)} FROM music_analysis WHERE {where_clause}"

    with conn.cursor() as cur:
        cur.execute(query)
        rows = cur.fetchall()

    if not rows:
        raise RuntimeError(f'No rows returned for mode {mode}. Ensure embeddings are populated.')

    identifiers = [row[0] for row in rows]
    data_matrix = np.array([row[1:] for row in rows], dtype=np.float64)

    if mode == 'pca':
        result = {
            'identifiers': np.array(identifiers),
            'primary_d': data_matrix[:, 0],
            'tonal': data_matrix[:, 1:4],
            'spectral': data_matrix[:, 4:7],
            'rhythmic': data_matrix[:, 7:10]
        }
    else:
        result = {
            'identifiers': np.array(identifiers),
            'latent': data_matrix
        }

    total = len(identifiers)
    logging.info('Loaded %d tracks with complete %s embeddings', total, mode.upper())
    return result


def build_resolution_percentiles(args: argparse.Namespace) -> Dict[str, Tuple[float, float]]:
    percentiles = dict(DEFAULT_RESOLUTION_PERCENTILES)
    if args.inner_percentile is not None or args.outer_percentile is not None:
        inner = args.inner_percentile if args.inner_percentile is not None else 0.05
        outer = args.outer_percentile if args.outer_percentile is not None else 0.20
        for key in percentiles:
            percentiles[key] = (inner, outer)
    return percentiles


def compute_distance_samples(
    data: Dict[str, np.ndarray],
    mode: str,
    sample_centers: int,
    neighbor_count: int,
    rng: np.random.Generator
) -> Tuple[Dict[str, List[float]], int, np.ndarray]:
    if mode == 'pca':
        discriminators = DEFAULT_PCA_DISCRIMINATORS
    else:
        discriminators = DEFAULT_VAE_DISCRIMINATORS

    distance_samples: Dict[str, List[float]] = {disc: [] for disc in discriminators}

    total_tracks = len(data['identifiers'])
    sample_count = min(sample_centers, total_tracks)
    sampled_indices = rng.choice(total_tracks, size=sample_count, replace=False)

    logging.info('Sampling %d center tracks (of %d total)', sample_count, total_tracks)

    for center_index in sampled_indices:
        if mode == 'pca':
            primary = np.abs(data['primary_d'] - data['primary_d'][center_index])
            primary[center_index] = np.inf

            tonal_diff = data['tonal'] - data['tonal'][center_index]
            tonal = np.linalg.norm(tonal_diff, axis=1)
            tonal[center_index] = np.inf

            spectral_diff = data['spectral'] - data['spectral'][center_index]
            spectral = np.linalg.norm(spectral_diff, axis=1)
            spectral[center_index] = np.inf

            rhythmic_diff = data['rhythmic'] - data['rhythmic'][center_index]
            rhythmic = np.linalg.norm(rhythmic_diff, axis=1)
            rhythmic[center_index] = np.inf

            disc_map = {
                'primary_d': primary,
                'tonal': tonal,
                'spectral': spectral,
                'rhythmic': rhythmic,
            }
        else:
            latent_diff = data['latent'] - data['latent'][center_index]
            latent = np.linalg.norm(latent_diff, axis=1)
            latent[center_index] = np.inf
            disc_map = {'latent': latent}

        for disc, values in disc_map.items():
            finite = values[np.isfinite(values)]
            if finite.size == 0:
                continue

            if finite.size > neighbor_count:
                neighbors = np.partition(finite, neighbor_count)[:neighbor_count]
            else:
                neighbors = finite

            distance_samples[disc].extend(neighbors.astype(float).tolist())

    return distance_samples, total_tracks, sampled_indices


def compute_checksum(payload: Dict) -> str:
    text = json.dumps(payload, sort_keys=True)
    return hashlib.sha1(text.encode('utf-8')).hexdigest()


def choose_radii(values: np.ndarray, inner_pct: float, outer_pct: float, mode: str) -> Tuple[float, float, Tuple[float, float], bool]:
    chosen_pair: Tuple[float, float] = (inner_pct, outer_pct)
    used_fallback = False

    def percentile_pair(pair: Tuple[float, float]) -> Tuple[float, float]:
        inner, outer = pair
        inner_val = float(np.percentile(values, inner * 100.0))
        outer_val = float(np.percentile(values, outer * 100.0))
        if outer_val < inner_val:
            inner_val, outer_val = outer_val, inner_val
        return inner_val, outer_val

    inner_radius, outer_radius = percentile_pair(chosen_pair)

    if outer_radius < MIN_EFFECTIVE_RADIUS:
        for fallback_pair in FALLBACK_PERCENTILE_PAIRS:
            inner_radius, outer_radius = percentile_pair(fallback_pair)
            if outer_radius >= MIN_EFFECTIVE_RADIUS:
                chosen_pair = fallback_pair
                used_fallback = True
                break

    if outer_radius < MIN_EFFECTIVE_RADIUS:
        inner_radius = float(np.median(values))
        outer_radius = float(np.max(values))
        chosen_pair = ('median', 'max')  # type: ignore
        used_fallback = True

    if outer_radius < MIN_EFFECTIVE_RADIUS:
        if mode == 'vae':
            logging.warning(
                'Using configured VAE fallback radius %.3f due to degenerate distance distribution',
                DEFAULT_VAE_FALLBACK_OUTER
            )
            inner_radius = 0.0
            outer_radius = DEFAULT_VAE_FALLBACK_OUTER
            chosen_pair = ('fallback', DEFAULT_VAE_FALLBACK_OUTER)  # type: ignore
            used_fallback = True
        else:
            outer_radius = MIN_EFFECTIVE_RADIUS

    return inner_radius, outer_radius, chosen_pair, used_fallback


def build_calibration_records(
    mode: str,
    distance_samples: Dict[str, List[float]],
    percentiles: Dict[str, Tuple[float, float]],
    library_size: int,
    sample_size: int
) -> List[CalibrationRecord]:
    calibrated_at = datetime.now(timezone.utc)
    records: List[CalibrationRecord] = []

    for resolution, (inner_pct, outer_pct) in percentiles.items():
        for discriminator, distances in distance_samples.items():
            if not distances:
                logging.warning('No distance samples for %s/%s - skipping', resolution, discriminator)
                continue

            values = np.asarray(distances, dtype=np.float64)
            inner_radius, outer_radius, chosen_pair, used_fallback = choose_radii(values, inner_pct, outer_pct, mode)

            achieved = float(np.mean(values <= outer_radius))
            payload = {
                'mode': mode,
                'resolution': resolution,
                'discriminator': discriminator,
                'inner_radius': inner_radius,
                'outer_radius': outer_radius,
                'sample_size': sample_size,
                'library_size': library_size,
            }
            checksum = compute_checksum(payload)

            if used_fallback:
                logging.warning(
                    'Adjusted radii for %s/%s using %s: inner %.6g outer %.6g',
                    resolution,
                    discriminator,
                    chosen_pair,
                    inner_radius,
                    outer_radius
                )

            record = CalibrationRecord(
                mode=mode,
                resolution=resolution,
                discriminator=discriminator,
                inner_radius=inner_radius,
                outer_radius=outer_radius,
                base_x=inner_radius,
                target_percentage=outer_pct,
                achieved_percentage=achieved,
                library_size=library_size,
                sample_size=sample_size,
                calibrated_at=calibrated_at,
                checksum=checksum
            )
            records.append(record)

    return records


UPSERT_SQL = """
INSERT INTO pca_calibration_settings (
    mode,
    resolution_level,
    discriminator,
    base_x,
    inner_radius,
    outer_radius,
    target_percentage,
    achieved_percentage,
    library_size,
    sample_size,
    calibrated_at,
    checksum
) VALUES (
    %(mode)s,
    %(resolution)s,
    %(discriminator)s,
    %(base_x)s,
    %(inner_radius)s,
    %(outer_radius)s,
    %(target_percentage)s,
    %(achieved_percentage)s,
    %(library_size)s,
    %(sample_size)s,
    %(calibrated_at)s,
    %(checksum)s
)
ON CONFLICT (mode, resolution_level, discriminator)
DO UPDATE SET
    base_x = EXCLUDED.base_x,
    inner_radius = EXCLUDED.inner_radius,
    outer_radius = EXCLUDED.outer_radius,
    target_percentage = EXCLUDED.target_percentage,
    achieved_percentage = EXCLUDED.achieved_percentage,
    library_size = EXCLUDED.library_size,
    sample_size = EXCLUDED.sample_size,
    calibrated_at = EXCLUDED.calibrated_at,
    checksum = EXCLUDED.checksum;
"""


def persist_records(conn, records: List[CalibrationRecord]) -> None:
    if not records:
        logging.warning('No calibration records to persist')
        return

    with conn.cursor() as cur:
        for record in records:
            cur.execute(UPSERT_SQL, {
                'mode': record.mode,
                'resolution': record.resolution,
                'discriminator': record.discriminator,
                'base_x': record.base_x,
                'inner_radius': record.inner_radius,
                'outer_radius': record.outer_radius,
                'target_percentage': record.target_percentage,
                'achieved_percentage': record.achieved_percentage,
                'library_size': record.library_size,
                'sample_size': record.sample_size,
                'calibrated_at': record.calibrated_at,
                'checksum': record.checksum,
            })
    conn.commit()


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )


def main():
    configure_logging()
    args = parse_args()
    database_url = resolve_database_url(args)

    rng = np.random.default_rng(args.seed)

    with psycopg2.connect(database_url) as conn:
        data = fetch_embedding_data(conn, args.mode)
        samples, library_size, sampled_indices = compute_distance_samples(
            data=data,
            mode=args.mode,
            sample_centers=args.sample_centers,
            neighbor_count=args.neighbor_count,
            rng=rng
        )

        percentiles = build_resolution_percentiles(args)
        records = build_calibration_records(
            mode=args.mode,
            distance_samples=samples,
            percentiles=percentiles,
            library_size=library_size,
            sample_size=len(sampled_indices)
        )

        if not records:
            raise SystemExit('No calibration records generated. Nothing to persist.')

        for record in records:
            logging.info(
                '%s/%s -> inner %.6f, outer %.6f (target %.2f, achieved %.2f)',
                record.resolution,
                record.discriminator,
                record.inner_radius,
                record.outer_radius,
                record.target_percentage,
                record.achieved_percentage,
            )

        if args.dry_run:
            logging.info('Dry run complete - skipping database write')
            return

        persist_records(conn, records)
        logging.info('Calibration data persisted for %d buckets', len(records))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:  # pragma: no cover - entrypoint guard
        logging.error('Calibration failed: %s', exc)
        raise
