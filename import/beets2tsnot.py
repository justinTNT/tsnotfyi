#!/usr/bin/env python3
"""
beets2tsnot.py - Ultimate Single-Dependency Music Analysis Pipeline

The definitive music analysis tool that takes only a beets database and produces
complete music indices with full metadata integration.

Key Features:
- Single dependency: Only requires beets database path
- Tranched processing: 100 → 1K → 10K → 100K → Full
- Complete metadata: All beets fields preserved with bt_ prefix
- Production grade: Robust error handling, resumable processing
- Zero intermediates: Direct beets → essentia → indices database

Usage:
    python beets2tsnot.py --beets-db ~/.config/beets/library.db --tranche proof_tools
"""

import argparse
import hashlib
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import traceback

# PostgreSQL support
try:
    import psycopg2
    import psycopg2.extras
    POSTGRES_AVAILABLE = True
except ImportError:
    POSTGRES_AVAILABLE = False

# PCA computation dependencies
import pandas as pd
import numpy as np
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.neighbors import NearestNeighbors

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler('beets2tsnot.log', mode='a')
    ]
)
logger = logging.getLogger(__name__)

# Tranche definitions for progressive scaling
TRANCHE_SIZES = {
    'proof_tools': 100,      # Prove the tools work
    'proof_app': 1000,       # Prove the application scales
    'make_fun': 10000,       # Make it fun to use
    'make_complete': 100000, # Make it complete
    'production': None       # No limit - full dataset
}

@dataclass
class ProcessingConfig:
    """Configuration for beets2tsnot processing"""
    # Core settings
    beets_db_path: str
    output_db_path: str = "tsnot_analysis.db"
    checkpoint_db_path: Optional[str] = None

    # PostgreSQL settings (if using PostgreSQL instead of SQLite)
    use_postgres: bool = False
    pg_host: str = "localhost"
    pg_port: int = 5432
    pg_database: str = "tsnotfyi"
    pg_user: str = "postgres"
    pg_password: Optional[str] = None  # From env var if not provided

    # Processing strategy
    tranche: str = "proof_tools"
    limit: Optional[int] = None
    offset: int = 0

    # Performance tuning
    parallel_jobs: int = 4
    chunk_size: int = 20
    batch_size: int = 100
    essentia_timeout: int = 600

    # Filtering options
    genre_filter: Optional[str] = None
    year_range: Optional[Tuple[int, int]] = None
    format_filter: Optional[str] = None

    # Processing options
    resume: bool = True
    validate_files: bool = True
    include_failed: bool = False

    # Path scoping
    paths: Optional[List[str]] = None
    path_prefixes: Optional[List[str]] = None

    # Debug options
    verbose: bool = False
    dry_run: bool = False

def compute_path_keywords(path_str: str) -> str:
    if not path_str:
        return ""
    segments = [seg for seg in path_str.split('/') if seg]
    if len(segments) <= 5:
        trimmed = path_str
    else:
        trimmed = ' '.join(segments[5:])
    trimmed = trimmed.rsplit('.', 1)[0] if segments and '.' in segments[-1] else trimmed
    return (
        trimmed
        .replace('_', ' ')
        .replace('-', ' ')
        .replace('.', ' ')
        .replace('/', ' ')
        .strip()
        .lower()
    )


CONTROL_CHAR_MAP = {i: None for i in range(32) if i not in (9, 10, 13)}


def _sanitize_string(text: str) -> str:
    """Remove disallowed control characters that break JSON parsers."""
    return text.translate(CONTROL_CHAR_MAP)


def decode_value(value):
    if isinstance(value, (bytes, memoryview)):
        try:
            value = bytes(value).decode('utf-8')
        except UnicodeDecodeError:
            value = bytes(value).hex()

    if isinstance(value, str):
        return _sanitize_string(value)
    return value


class BeetsMetadataExtractor:
    """Extracts comprehensive metadata from beets database"""

    def __init__(self, beets_db_path: str):
        self.beets_db_path = beets_db_path
        self.beets_db = None
        self._connect()

    def _connect(self):
        """Connect to beets database"""
        try:
            self.beets_db = sqlite3.connect(self.beets_db_path, timeout=30.0, check_same_thread=False)
            self.beets_db.row_factory = sqlite3.Row
            logger.info(f"Connected to beets database: {self.beets_db_path}")
        except Exception as e:
            logger.error(f"Failed to connect to beets database: {e}")
            raise

    def get_all_columns(self) -> List[str]:
        """Get all column names from beets items table"""
        cursor = self.beets_db.execute("PRAGMA table_info(items)")
        columns = [row['name'] for row in cursor.fetchall()]
        logger.info(f"Found {len(columns)} beets metadata columns")
        return columns

    def build_query(self, config: ProcessingConfig) -> Tuple[str, List[Any]]:
        """Build SQL query based on configuration"""
        base_query = "SELECT * FROM items WHERE path IS NOT NULL AND path != ''"
        conditions = []
        params = []

        # Add filters
        if config.genre_filter:
            conditions.append("genre LIKE ?")
            params.append(f"%{config.genre_filter}%")

        if config.year_range:
            start_year, end_year = config.year_range
            conditions.append("year BETWEEN ? AND ?")
            params.extend([start_year, end_year])

        if config.format_filter:
            conditions.append("format = ?")
            params.append(config.format_filter.upper())

        if config.paths:
            placeholders = ", ".join(["?"] * len(config.paths))
            conditions.append(f"path IN ({placeholders})")
            params.extend(path.encode('utf-8') for path in config.paths)

        if config.path_prefixes:
            prefix_clauses = []
            for prefix in config.path_prefixes:
                prefix_clauses.append("CAST(path AS TEXT) LIKE ?")
                params.append(f"{prefix}%")
            if prefix_clauses:
                conditions.append("(" + " OR ".join(prefix_clauses) + ")")

        # Combine conditions
        if conditions:
            base_query += " AND " + " AND ".join(conditions)

        # Add ordering and limits - match original results.db order
        base_query += " ORDER BY added ASC"

        # Apply explicit limits first, then tranche
        if config.limit:
            base_query += f" LIMIT {config.limit}"
            if config.offset > 0:
                base_query += f" OFFSET {config.offset}"
        elif config.tranche in TRANCHE_SIZES:
            tranche_limit = TRANCHE_SIZES[config.tranche]
            if tranche_limit:
                base_query += f" LIMIT {tranche_limit}"
            if config.offset > 0:
                base_query += f" OFFSET {config.offset}"

        return base_query, params

    def get_tracks(self, config: ProcessingConfig) -> List[Dict]:
        """Get tracks from beets database based on configuration"""
        query, params = self.build_query(config)

        logger.info(f"Executing beets query with tranche '{config.tranche}'")

        cursor = self.beets_db.execute(query, params)
        tracks = []

        for row in cursor.fetchall():
            track_data = dict(row)

            # Generate identifier from path
            path = track_data['path']
            if isinstance(path, bytes):
                path = path.decode('utf-8', errors='ignore')
            identifier = hashlib.md5(path.encode('utf-8')).hexdigest()

            if config.paths and path not in config.paths:
                continue
            if config.path_prefixes and not any(path.startswith(prefix) for prefix in config.path_prefixes):
                continue

            # Add computed fields
            track_data['identifier'] = identifier
            track_data['path_str'] = path
            track_data['path_keywords'] = compute_path_keywords(path)

            item_dict = {k: decode_value(v) for k, v in dict(row).items()}

            album_row = None
            if row['album_id'] is not None:
                album_row = self.beets_db.execute(
                    "SELECT * FROM albums WHERE id = ?",
                    (row['album_id'],)
                ).fetchone()
            album_dict = {k: decode_value(v) for k, v in dict(album_row).items()} if album_row else None

            item_attrs = {
                decode_value(attr_row[0]): decode_value(attr_row[1])
                for attr_row in self.beets_db.execute(
                    "SELECT key, value FROM item_attributes WHERE entity_id = ?",
                    (row['id'],)
                )
                if attr_row[0]
            }

            album_attrs = {}
            if album_row is not None:
                album_attrs = {
                    decode_value(attr_row[0]): decode_value(attr_row[1])
                    for attr_row in self.beets_db.execute(
                        "SELECT key, value FROM album_attributes WHERE entity_id = ?",
                        (album_row['id'],)
                    )
                    if attr_row[0]
                }

            meta_payload = {
                'item': item_dict,
                'album': album_dict,
                'item_attributes': item_attrs,
                'album_attributes': album_attrs
            }
            track_data['beets_meta'] = json.dumps(meta_payload, ensure_ascii=True, sort_keys=True)

            tracks.append(track_data)

        logger.info(f"Retrieved {len(tracks)} tracks from beets database")
        return tracks

    def close(self):
        """Close database connection"""
        if self.beets_db:
            self.beets_db.close()

class EssentiaProcessor:
    """Handles Essentia feature extraction with robust error handling"""

    def __init__(self, config: ProcessingConfig):
        self.config = config
        self.stats = {
            'processed': 0,
            'failed': 0,
            'skipped': 0,
            'errors': {}
        }

    def extract_features(self, track_path: str, track_id: str) -> Tuple[Optional[Dict], Optional[Dict[str, str]]]:
        """Extract Essentia features from audio file.

        Returns:
            tuple: (features, error_info)
                features: Parsed Essentia JSON when successful, otherwise None
                error_info: Optional dict with 'type' and 'message' describing the failure
        """
        amplified_path = None
        tried_amplify = False
        silent_attempted = False

        try:
            # Validate file exists if enabled
            if self.config.validate_files and not Path(track_path).exists():
                msg = f"File not found: {track_path}"
                logger.warning(msg)
                self._record_error('file_not_found', track_id)
                return None, {'type': 'file_not_found', 'message': msg}

            while True:
                path_to_use = amplified_path or track_path

                # Create temporary file for Essentia output
                with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tmp:
                    tmp_path = tmp.name

                try:
                    cmd = [
                        '/opt/homebrew/bin/essentia_streaming_extractor_music',
                        path_to_use,
                        tmp_path
                    ]

                    result = subprocess.run(
                        cmd,
                        timeout=self.config.essentia_timeout,
                        capture_output=True,
                        text=True
                    )

                    if result.returncode != 0:
                        stderr = (result.stderr or '').strip()
                        if 'completely silent file' in stderr.lower():
                            if not tried_amplify and self._can_amplify(track_path):
                                amplified_path = self._amplify_track(track_path)
                                if amplified_path:
                                    tried_amplify = True
                                    logger.info(f"Amplified quiet track for Essentia: {track_path}")
                                    continue

                            if not silent_attempted:
                                logger.info(f"Essentia reported silence for {track_path}; generating synthetic features")
                                silent_attempted = True
                                features = self._generate_silent_features(track_path)
                                return features, None

                        stderr_snippet = stderr[:200]
                        msg = f"Essentia failed for {track_id}: {stderr_snippet}" if stderr_snippet else f"Essentia failed for {track_id}"
                        logger.error(msg)
                        self._record_error('essentia_failed', track_id)
                        return None, {'type': 'essentia_failed', 'message': msg}

                    with open(tmp_path, 'r', encoding='utf-8') as f:
                        raw_json = f.read()
                    sanitized_json = _sanitize_string(raw_json)
                    features = json.loads(sanitized_json)
                    return features, None

                finally:
                    Path(tmp_path).unlink(missing_ok=True)

        except subprocess.TimeoutExpired:
            msg = f"Essentia timeout for {track_id} (>{self.config.essentia_timeout}s)"
            logger.error(msg)
            self._record_error('timeout', track_id)
            return None, {'type': 'timeout', 'message': msg}

        except json.JSONDecodeError as e:
            msg = f"JSON parsing failed for {track_id}: {e}"
            logger.error(msg)
            self._record_error('json_parse', track_id)
            return None, {'type': 'json_parse', 'message': msg}

        except Exception as e:
            msg = f"Unexpected error extracting features for {track_id}: {e}"
            logger.error(msg)
            self._record_error('unexpected', track_id)
            return None, {'type': 'unexpected', 'message': msg}

        finally:
            if amplified_path:
                Path(amplified_path).unlink(missing_ok=True)

    def _can_amplify(self, track_path: str) -> bool:
        return Path(track_path).suffix.lower() in {'.flac', '.mp3', '.wav', '.aiff', '.aif', '.aac', '.ogg', '.m4a'}

    def _amplify_track(self, track_path: str) -> Optional[str]:
        try:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_audio:
                amplified_path = tmp_audio.name

            cmd = [
                'ffmpeg',
                '-nostdin',
                '-y',
                '-i', track_path,
                '-af', 'volume=+50dB',
                '-acodec', 'pcm_s16le',
                '-ar', '44100',
                amplified_path
            ]

            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                stderr_snippet = (result.stderr or '').strip()[:200]
                logger.warning(f"Failed to amplify {track_path}: {stderr_snippet}")
                Path(amplified_path).unlink(missing_ok=True)
                return None

            return amplified_path

        except Exception as e:
            logger.warning(f"Amplification failed for {track_path}: {e}")
            return None

    def _generate_silent_features(self, track_path: str) -> Dict[str, Any]:
        return {
            'metadata': {
                'audio_properties': {
                    'length': 0.0,
                    'silence_detected': True,
                    'source_path': track_path
                }
            },
            'rhythm': {
                'bpm': 0.0,
                'danceability': 0.0,
                'onset_rate': 0.0,
                'beats_loudness': {'mean': 0.0},
                'bpm_histogram_first_peak_weight': 0.0,
                'bpm_histogram_second_peak_weight': 0.0
            },
            'tonal': {
                'tuning_diatonic_strength': 0.0,
                'chords_strength': {'mean': 0.0},
                'chords_changes_rate': 0.0,
                'hpcp_crest': {'mean': 0.0},
                'hpcp_entropy': {'mean': 0.0},
                'key_edma': {'strength': 0.0},
                'key_krumhansl': {'strength': 0.0},
                'key_temperley': {'strength': 0.0}
            },
            'lowlevel': {
                'spectral_centroid': {'mean': 0.0},
                'spectral_rolloff': {'mean': 0.0},
                'spectral_kurtosis': {'mean': 0.0},
                'spectral_energy': {'mean': 0.0},
                'barkbands_flatness_db': {'mean': 0.0}
            }
        }

    def _record_error(self, error_type: str, track_id: str):
        """Record error statistics"""
        if error_type not in self.stats['errors']:
            self.stats['errors'][error_type] = []
        self.stats['errors'][error_type].append(track_id)
        self.stats['failed'] += 1

class FeatureProcessor:
    """Processes Essentia features into flattened columns and calculates indices"""

    def __init__(self):
        self.epsilon = 1e-12

    def flatten_essentia_features(self, features: Dict) -> Dict:
        """Flatten nested Essentia JSON into columns"""
        flattened = {}
        self._flatten_recursive(features, flattened, "essentia")
        return flattened

    def _flatten_recursive(self, data: Dict, result: Dict, prefix: str):
        """Recursively flatten nested dictionary"""
        for key, value in data.items():
            new_key = f"{prefix}__{key}"

            if isinstance(value, dict):
                self._flatten_recursive(value, result, new_key)
            elif isinstance(value, list):
                if len(value) > 0 and isinstance(value[0], (int, float)):
                    # Numeric arrays - create indexed columns
                    for i, item in enumerate(value):
                        result[f"{new_key}__{i}"] = item
                else:
                    # Non-numeric arrays - serialize to JSON
                    result[new_key] = json.dumps(value)
            else:
                result[new_key] = value

    def extract_indices(self, flattened_features: Dict) -> Dict:
        """Extract 21 music indices from flattened features"""
        indices = {}

        # Direct indices (14)
        indices.update(self._extract_direct_indices(flattened_features))

        # Calculated indices (7)
        indices.update(self._calculate_derived_indices(indices, flattened_features))

        return indices

    def _extract_direct_indices(self, features: Dict) -> Dict:
        """Extract direct indices from features"""
        mapping = {
            # Rhythmic (4)
            'bpm': 'essentia__rhythm__bpm',
            'danceability': 'essentia__rhythm__danceability',
            'onset_rate': 'essentia__rhythm__onset_rate',
            'beat_punch': 'essentia__rhythm__beats_loudness__mean',

            # Tonal (3)
            'fifths_strength': 'essentia__tonal__tuning_diatonic_strength',
            'chord_strength': 'essentia__tonal__chords_strength__mean',
            'chord_change_rate': 'essentia__tonal__chords_changes_rate',

            # Harmonic Shape (2)
            'crest': 'essentia__tonal__hpcp_crest__mean',
            'entropy': 'essentia__tonal__hpcp_entropy__mean',

            # Spectral (5)
            'spectral_centroid': 'essentia__lowlevel__spectral_centroid__mean',
            'spectral_rolloff': 'essentia__lowlevel__spectral_rolloff__mean',
            'spectral_kurtosis': 'essentia__lowlevel__spectral_kurtosis__mean',
            'spectral_energy': 'essentia__lowlevel__spectral_energy__mean',
            'spectral_flatness': 'essentia__lowlevel__barkbands_flatness_db__mean',
        }

        indices = {}
        for index_name, feature_key in mapping.items():
            indices[index_name] = features.get(feature_key, 0.0)

        return indices

    def _calculate_derived_indices(self, indices: Dict, features: Dict) -> Dict:
        """Calculate derived indices"""
        derived = {}

        # 1. opb (Onsets per Beat)
        bpm_safe = max(indices['bpm'], self.epsilon)
        derived['opb'] = indices['onset_rate'] * 60 / bpm_safe

        # 2. tonal_clarity (max of key detection strengths)
        key_strengths = [
            features.get('essentia__tonal__key_edma__strength', 0.0),
            features.get('essentia__tonal__key_krumhansl__strength', 0.0),
            features.get('essentia__tonal__key_temperley__strength', 0.0),
        ]
        derived['tonal_clarity'] = max(key_strengths)

        # 3. pulse_cohesion (BPM histogram ratio)
        first_peak = features.get('essentia__rhythm__bpm_histogram_first_peak_weight', 0.0)
        second_peak = features.get('essentia__rhythm__bpm_histogram_second_peak_weight', 0.0)
        derived['pulse_cohesion'] = first_peak / (second_peak + self.epsilon)

        # 4. tuning_purity
        deviation = features.get('essentia__tonal__tuning_equal_tempered_deviation', 0.0)
        derived['tuning_purity'] = max(0, min(1, 1 - abs(deviation) / 50))

        # 5 & 6. sub_drive and air_sizzle (spectral energy distribution)
        centroid = indices['spectral_centroid']
        rolloff = indices['spectral_rolloff']

        # Normalize by maximum values (will be properly scaled later)
        max_centroid = max(centroid, self.epsilon)
        centroid_norm = centroid / max_centroid

        max_rolloff = max(rolloff, self.epsilon)
        rolloff_norm = rolloff / max_rolloff

        derived['sub_drive'] = max(0, min(1, 1 - centroid_norm))
        derived['air_sizzle'] = max(0, min(1, centroid_norm * rolloff_norm))

        # 7. spectral_slope
        air = derived['air_sizzle']
        sub = derived['sub_drive']
        derived['spectral_slope'] = (air - sub) / (air + sub + self.epsilon)

        return derived


class PCAComputer:
    """Computes PCA transformations and values for music indices.

    This class handles:
    - Loading all track indices from database
    - Fitting PCA models on 4 discriminator spaces:
      * primary_d: 1D PCA on all 18 core features
      * tonal: 3D PCA on 7 tonal features
      * spectral: 3D PCA on 7 spectral features
      * rhythmic: 3D PCA on 4 rhythmic features
    - Extracting transformation weights (components, means, scales)
    - Dynamic calibration for 3 resolution levels
    - Validation of computed values
    """

    def __init__(self):
        """Initialize PCA computer with feature groupings."""
        # Core feature groups (18 features total)
        self.core_indices = [
            'bpm', 'danceability', 'onset_rate', 'beat_punch',
            'tonal_clarity', 'tuning_purity', 'fifths_strength',
            'chord_strength', 'chord_change_rate', 'crest', 'entropy',
            'spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
            'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'
        ]

        # Domain groupings
        self.domain_indices = {
            'tonal': ['tonal_clarity', 'tuning_purity', 'fifths_strength',
                     'chord_strength', 'chord_change_rate', 'crest', 'entropy'],
            'spectral': ['spectral_centroid', 'spectral_rolloff', 'spectral_kurtosis',
                        'spectral_energy', 'spectral_flatness', 'sub_drive', 'air_sizzle'],
            'rhythmic': ['bpm', 'danceability', 'onset_rate', 'beat_punch']
        }

        # Storage for fitted models
        self.scaler = None  # Global scaler for all 18 features
        self.discriminators = {}  # Will store PCA models and scalers
        self.data = None  # DataFrame of all tracks

    def fit_pca_on_library(self, db_config) -> Dict[str, np.ndarray]:
        """Fit PCA models on entire library.

        Args:
            db_config: Either a database path (str) for SQLite, or ProcessingConfig for PostgreSQL

        Returns:
            Dict mapping discriminator names to value arrays
        """
        logger.info("🧮 FITTING PCA ON LIBRARY")
        logger.info("="*60)

        # Load all track indices
        if isinstance(db_config, str):
            # SQLite path (legacy)
            conn = sqlite3.connect(db_config)
        elif hasattr(db_config, 'use_postgres') and db_config.use_postgres:
            # PostgreSQL config
            conn = psycopg2.connect(
                host=db_config.pg_host,
                port=db_config.pg_port,
                database=db_config.pg_database,
                user=db_config.pg_user,
                password=db_config.pg_password or os.getenv('PGPASSWORD')
            )
        else:
            # ProcessingConfig with SQLite
            conn = sqlite3.connect(db_config.output_db_path)

        # Build query
        columns = ['identifier'] + self.core_indices
        query = f"SELECT {', '.join(columns)} FROM music_analysis WHERE identifier IS NOT NULL"

        self.data = pd.read_sql_query(query, conn)
        conn.close()

        n_tracks = len(self.data)
        logger.info(f"Loaded {n_tracks:,} tracks with {len(self.core_indices)} features")

        if n_tracks < 1000:
            logger.warning(f"⚠️  Only {n_tracks} tracks - PCA may be unstable (recommend 1000+)")

        # Extract feature matrix
        core_data = self.data[self.core_indices].fillna(0).values

        # Fit global scaler
        self.scaler = StandardScaler()
        core_scaled = self.scaler.fit_transform(core_data)

        logger.info(f"Standardized features (mean≈0, std≈1)")

        # Fit primary discriminator (1D PCA on all 18 features)
        logger.info("\nFitting primary_d (1D PCA on 18 features)...")
        pca_primary = PCA(n_components=1, random_state=42)
        pca_primary.fit(core_scaled)

        d_values = pca_primary.transform(core_scaled)[:, 0]
        variance_explained = pca_primary.explained_variance_ratio_[0]

        self.discriminators['primary_d'] = {
            'values': d_values,
            'pca_model': pca_primary,
            'scaler': self.scaler,
            'variance_explained': variance_explained,
            'n_components': 1,
            'feature_indices': self.core_indices
        }

        logger.info(f"  ✅ primary_d: {variance_explained:.1%} variance explained")

        # Fit domain discriminators (3D PCA each)
        for domain_name, indices in self.domain_indices.items():
            logger.info(f"\nFitting {domain_name} (3D PCA on {len(indices)} features)...")

            # Extract domain data
            domain_data = self.data[indices].fillna(0).values

            # Fit domain scaler
            domain_scaler = StandardScaler()
            domain_scaled = domain_scaler.fit_transform(domain_data)

            # Fit domain PCA (3 components)
            pca_domain = PCA(n_components=3, random_state=42)
            pca_domain.fit(domain_scaled)

            domain_values = pca_domain.transform(domain_scaled)
            total_variance = np.sum(pca_domain.explained_variance_ratio_)

            self.discriminators[domain_name] = {
                'values': domain_values,
                'pca_model': pca_domain,
                'scaler': domain_scaler,
                'total_variance': total_variance,
                'n_components': 3,
                'feature_indices': indices
            }

            logger.info(f"  ✅ {domain_name}: {total_variance:.1%} variance explained")

        logger.info(f"\n✅ All PCA models fitted successfully")

        return self.discriminators

    def extract_transformation_weights(self) -> List[Tuple]:
        """Extract PCA transformation weights from fitted models.

        Returns:
            List of (component, feature_index, feature_name, weight, mean, scale) tuples
            Expected: 72 rows (18 + 21 + 21 + 12)
        """
        logger.info("\n🔬 EXTRACTING PCA TRANSFORMATION WEIGHTS")
        logger.info("="*60)

        weights = []

        # 1. Primary discriminator (18 features, 1 component)
        logger.info("Extracting primary_d weights (18 features)...")
        pca_primary = self.discriminators['primary_d']['pca_model']

        for feature_idx, feature_name in enumerate(self.core_indices):
            weight = float(pca_primary.components_[0][feature_idx])
            mean = float(self.scaler.mean_[feature_idx])
            scale = float(self.scaler.scale_[feature_idx])

            weights.append((
                'primary_d',
                feature_idx,
                feature_name,
                weight,
                mean,
                scale
            ))

        logger.info(f"  ✅ Extracted {len(self.core_indices)} primary_d weights")

        # 2. Domain discriminators (tonal, spectral, rhythmic)
        for domain_name in ['tonal', 'spectral', 'rhythmic']:
            domain_info = self.discriminators[domain_name]
            pca_model = domain_info['pca_model']
            scaler = domain_info['scaler']
            feature_indices = domain_info['feature_indices']
            n_components = domain_info['n_components']

            logger.info(f"Extracting {domain_name} weights ({len(feature_indices)} features × {n_components} components)...")

            for component_idx in range(n_components):
                component_name = f"{domain_name}_pc{component_idx + 1}"

                for feature_idx, feature_name in enumerate(feature_indices):
                    weight = float(pca_model.components_[component_idx][feature_idx])
                    mean = float(scaler.mean_[feature_idx])
                    scale = float(scaler.scale_[feature_idx])

                    weights.append((
                        component_name,
                        feature_idx,
                        feature_name,
                        weight,
                        mean,
                        scale
                    ))

            logger.info(f"  ✅ Extracted {len(feature_indices) * n_components} {domain_name} weights")

        logger.info(f"\n✅ Total transformation weights extracted: {len(weights)}")
        logger.info(f"   Expected: 72 (18 primary_d + 21 tonal + 21 spectral + 12 rhythmic)")

        if len(weights) != 72:
            logger.warning(f"   ⚠️  WARNING: Expected 72 weights, got {len(weights)}")

        return weights

    def calibrate_resolution_controls(self) -> Dict[str, Any]:
        """Calibrate intuitive resolution controls using dynamic binary search.

        Finds optimal 2x→3x base scales for target percentages:
        - 🔬 Microscope (1%): Ultra-precise similarity
        - 🔍 Magnifying Glass (5%): Focused exploration
        - 🔭 Binoculars (10%): Broader discovery

        Returns:
            Dict with calibration results for all resolutions and discriminators
        """
        logger.info("\n🎯 CALIBRATING RESOLUTION CONTROLS (DYNAMIC)")
        logger.info("="*70)

        # Build NN models for each discriminator
        logger.info("Building nearest neighbor models...")
        discriminator_data = {
            'primary_d': self.discriminators['primary_d']['values'].reshape(-1, 1),
            'tonal': self.discriminators['tonal']['values'],
            'spectral': self.discriminators['spectral']['values'],
            'rhythmic': self.discriminators['rhythmic']['values']
        }

        nn_models = {}
        n_tracks = len(self.data)
        search_k = min(2000, n_tracks)

        for name, values in discriminator_data.items():
            nn_models[name] = NearestNeighbors(n_neighbors=search_k, metric='euclidean')
            nn_models[name].fit(values)
            logger.info(f"  ✅ {name}: {values.shape[1]}D space, k={search_k}")

        # Target resolutions
        target_resolutions = {
            'microscope': {'emoji': '🔬', 'target_pct': 1.0, 'description': 'Ultra-precise similarity'},
            'magnifying_glass': {'emoji': '🔍', 'target_pct': 5.0, 'description': 'Focused exploration'},
            'binoculars': {'emoji': '🔭', 'target_pct': 10.0, 'description': 'Broader discovery'}
        }

        # Test query indices (sample different parts of library)
        n_test_queries = min(15, n_tracks)
        test_indices = np.linspace(0, n_tracks-1, n_test_queries, dtype=int)

        calibration_results = {}

        logger.info(f"\nFinding optimal 2x→3x base scales (testing on {n_test_queries} query points)...")

        for resolution_name, resolution_config in target_resolutions.items():
            emoji = resolution_config['emoji']
            target_pct = resolution_config['target_pct']
            description = resolution_config['description']

            logger.info(f"\n{emoji} {resolution_name.replace('_', ' ').title()} ({target_pct}%): {description}")

            calibration_results[resolution_name] = {
                'config': resolution_config,
                'discriminator_calibrations': {}
            }

            # Calibrate each discriminator
            for disc_name in ['primary_d', 'tonal', 'spectral', 'rhythmic']:
                # Binary search for optimal base_x
                x_candidates = np.logspace(-2, 0.5, 50)  # 0.01 to ~3.16
                best_x = None
                best_error = float('inf')
                best_avg_pct = None

                for x in x_candidates:
                    inner_radius = 2 * x
                    outer_radius = 3 * x

                    percentages = []

                    for query_idx in test_indices:
                        query_point = discriminator_data[disc_name][query_idx:query_idx+1]
                        distances, _ = nn_models[disc_name].kneighbors(query_point)
                        distances = distances[0]

                        in_zone = np.sum((distances >= inner_radius) & (distances <= outer_radius))
                        percentage = (in_zone / len(distances)) * 100
                        percentages.append(percentage)

                    avg_percentage = np.mean(percentages)
                    error = abs(avg_percentage - target_pct)

                    if error < best_error:
                        best_error = error
                        best_x = x
                        best_avg_pct = avg_percentage

                result = {
                    'best_x': best_x,
                    'best_inner': 2 * best_x,
                    'best_outer': 3 * best_x,
                    'achieved_percentage': best_avg_pct,
                    'error': best_error
                }

                calibration_results[resolution_name]['discriminator_calibrations'][disc_name] = result

                logger.info(f"   {disc_name:<12}: x={best_x:.3f} → {best_avg_pct:.1f}% (error: {best_error:.1f}%)")

        logger.info(f"\n✅ Dynamic calibration complete for all resolution levels")

        return calibration_results

    def validate_pca_integrity(self, db_manager) -> bool:
        """Validate PCA values in database match computed values.

        Cross-references database PCA values against freshly computed values.
        Raises ValueError if validation fails.

        Args:
            db_manager: Active DatabaseManager instance

        Returns:
            True if validation passes

        Raises:
            ValueError: If validation fails
        """
        logger.info("\n✅ VALIDATING PCA INTEGRITY")
        logger.info("="*70)

        conn = None

        try:
            if db_manager.config.use_postgres:
                conn = psycopg2.connect(
                    host=db_manager.config.pg_host,
                    port=db_manager.config.pg_port,
                    database=db_manager.config.pg_database,
                    user=db_manager.config.pg_user,
                    password=db_manager.config.pg_password or os.getenv('PGPASSWORD')
                )
            else:
                conn = sqlite3.connect(db_manager.db_path)

            db_df = pd.read_sql_query("""
                SELECT identifier, primary_d, tonal_pc1, tonal_pc2, tonal_pc3,
                       spectral_pc1, spectral_pc2, spectral_pc3,
                       rhythmic_pc1, rhythmic_pc2, rhythmic_pc3
                FROM music_analysis
                WHERE primary_d IS NOT NULL
            """, conn)

            logger.info(f"Loaded {len(db_df):,} database records")

            # Compare with computed values
            tolerance = 1e-10
            validation_results = {}
            all_passed = True

            computed_df = pd.DataFrame({
                'identifier': self.data['identifier'],
                'primary_d_computed': self.discriminators['primary_d']['values']
            })

            for domain in ['tonal', 'spectral', 'rhythmic']:
                values = self.discriminators[domain]['values']
                for idx in range(self.discriminators[domain]['n_components']):
                    computed_df[f'{domain}_pc{idx + 1}_computed'] = values[:, idx]

            merged = db_df.merge(computed_df, on='identifier')

            if merged.empty:
                raise ValueError("No overlapping identifiers between computed PCA data and database records")

            # Validate primary_d
            db_primary_d = merged['primary_d'].values
            computed_primary_d = merged['primary_d_computed'].values
            diff = np.abs(db_primary_d - computed_primary_d)
            max_diff = np.max(diff)
            matches = np.sum(diff < tolerance)
            match_pct = (matches / len(db_primary_d)) * 100

            validation_results['primary_d'] = {
                'matches': int(matches),
                'total': len(db_primary_d),
                'match_pct': match_pct,
                'max_diff': float(max_diff),
                'passed': match_pct > 99.9
            }

            logger.info(f"primary_d: {matches:,}/{len(db_primary_d):,} exact matches ({match_pct:.2f}%), max diff: {max_diff:.2e}")

            if not validation_results['primary_d']['passed']:
                all_passed = False
                logger.error(f"  ❌ FAILED: Match percentage below threshold")

            # Validate domain components
            for domain in ['tonal', 'spectral', 'rhythmic']:
                n_components = self.discriminators[domain]['n_components']

                for component_idx in range(n_components):
                    column_name = f"{domain}_pc{component_idx + 1}"
                    db_column = merged[column_name].values
                    computed_column = merged[f'{column_name}_computed'].values

                    diff = np.abs(db_column - computed_column)
                    max_diff = np.max(diff)
                    matches = np.sum(diff < tolerance)
                    match_pct = (matches / len(db_column)) * 100

                    validation_results[column_name] = {
                        'matches': int(matches),
                        'total': len(db_column),
                        'match_pct': match_pct,
                        'max_diff': float(max_diff),
                        'passed': match_pct > 99.9
                    }

                    logger.info(f"{column_name}: {matches:,}/{len(db_column):,} exact matches ({match_pct:.2f}%), max diff: {max_diff:.2e}")

                    if not validation_results[column_name]['passed']:
                        all_passed = False
                        logger.error(f"  ❌ FAILED: Match percentage below threshold")

            # Overall summary
            total_values = sum(r['total'] for r in validation_results.values())
            total_matches = sum(r['matches'] for r in validation_results.values())
            overall_match_pct = (total_matches / total_values) * 100

            logger.info(f"\n📊 OVERALL VALIDATION:")
            logger.info(f"   Total values checked: {total_values:,}")
            logger.info(f"   Total exact matches: {total_matches:,}")
            logger.info(f"   Overall match rate: {overall_match_pct:.2f}%")
            logger.info(f"   Status: {'✅ PASSED' if all_passed else '❌ FAILED'}")

            if not all_passed:
                raise ValueError("PCA integrity validation failed: computed values do not match database values")

            return True

        except Exception as e:
            logger.error(f"❌ PCA integrity validation error: {e}")
            raise
        finally:
            if conn is not None:
                conn.close()


class DatabaseManager:
    """Manages the output database with comprehensive beets metadata integration"""

    def __init__(self, config: ProcessingConfig):
        self.config = config
        self.db_path = config.output_db_path
        self.db = None
        self.beets_columns = []
        self._connect()

    def _connect(self):
        """Connect to output database"""
        if self.config.use_postgres:
            if not POSTGRES_AVAILABLE:
                raise ImportError("PostgreSQL requested but psycopg2 not installed. Run: pip install psycopg2-binary")

            try:
                self.db = psycopg2.connect(
                    host=self.config.pg_host,
                    port=self.config.pg_port,
                    database=self.config.pg_database,
                    user=self.config.pg_user,
                    password=self.config.pg_password or os.getenv('PGPASSWORD')
                )
                self.db.autocommit = False  # Explicit transaction control

                # Set session parameters (equivalent to SQLite PRAGMA)
                with self.db.cursor() as cur:
                    cur.execute("SET work_mem = '50MB'")
                    cur.execute("SET maintenance_work_mem = '256MB'")
                    cur.execute("SET synchronous_commit = OFF")  # Faster bulk inserts

                logger.info(f"Connected to PostgreSQL database: {self.config.pg_database}")

            except Exception as e:
                logger.error(f"Failed to connect to PostgreSQL: {e}")
                raise
        else:
            # SQLite connection (original behavior)
            self.db = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA synchronous=NORMAL")
            self.db.execute("PRAGMA cache_size=10000")
            logger.info(f"Connected to SQLite database: {self.db_path}")

    def initialize_schema(self, beets_columns: List[str]):
        """Initialize database schema with beets metadata integration"""
        self.beets_columns = beets_columns

        # Create main analysis table
        columns_sql = self._build_columns_sql()

        # Adjust types based on database
        identifier_type = "VARCHAR(32)" if self.config.use_postgres else "TEXT"
        autoincrement = "SERIAL" if self.config.use_postgres else "INTEGER PRIMARY KEY AUTOINCREMENT"

        create_sql = f"""
        CREATE TABLE IF NOT EXISTS music_analysis (
            identifier {identifier_type} PRIMARY KEY,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            -- Beets metadata (bt_ prefix)
            {columns_sql['beets']},

            -- Music indices (21 total)
            {columns_sql['indices']}
        )
        """

        metadata_table_sql = f"""
        CREATE TABLE IF NOT EXISTS processing_metadata (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """

        log_table_sql = f"""
        CREATE TABLE IF NOT EXISTS processing_log (
            id {autoincrement},
            identifier TEXT,
            status TEXT,
            error_type TEXT,
            error_message TEXT,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            {"" if self.config.use_postgres else ""}
        )
        """

        if self.config.use_postgres:
            # PostgreSQL uses cursor pattern
            with self.db.cursor() as cur:
                cur.execute(create_sql)
                cur.execute(metadata_table_sql)
                cur.execute(log_table_sql)
        else:
            # SQLite uses direct execute
            self.db.execute(create_sql)
            self.db.execute(metadata_table_sql)
            self.db.execute(log_table_sql)

        # Create indexes
        self._create_indexes()

        self.db.commit()
        logger.info("Database schema initialized")

    def _build_columns_sql(self) -> Dict[str, str]:
        """Build SQL column definitions"""

        # Type mappings based on database
        float_type = "DOUBLE PRECISION" if self.config.use_postgres else "REAL"

        # Beets metadata columns with bt_ prefix
        beets_cols = []
        for col in self.beets_columns:
            if col == 'id':
                beets_cols.append(f"bt_id INTEGER")
            elif col in ['path']:
                beets_cols.append(f"bt_{col} TEXT")
            elif col in ['length', 'mtime', 'added', 'rg_track_gain', 'rg_track_peak', 'rg_album_gain', 'rg_album_peak', 'r128_track_gain', 'r128_album_gain']:
                beets_cols.append(f"bt_{col} {float_type}")
            elif col in ['year', 'month', 'day', 'track', 'tracktotal', 'disc', 'disctotal', 'comp', 'bitrate', 'samplerate', 'bitdepth', 'channels', 'original_year', 'original_month', 'original_day', 'bpm']:
                beets_cols.append(f"bt_{col} INTEGER")
            else:
                beets_cols.append(f"bt_{col} TEXT")

        beets_cols.append("path_keywords TEXT")
        beets_cols.append("beets_meta TEXT")

        # Music indices columns
        indices_cols = [
            # Rhythmic
            f"bpm {float_type}", f"danceability {float_type}", f"onset_rate {float_type}", f"beat_punch {float_type}",
            # Tonal
            f"tonal_clarity {float_type}", f"tuning_purity {float_type}", f"fifths_strength {float_type}",
            f"chord_strength {float_type}", f"chord_change_rate {float_type}",
            # Harmonic
            f"crest {float_type}", f"entropy {float_type}",
            # Spectral
            f"spectral_centroid {float_type}", f"spectral_rolloff {float_type}", f"spectral_kurtosis {float_type}",
            f"spectral_energy {float_type}", f"spectral_flatness {float_type}",
            # Production
            f"sub_drive {float_type}", f"air_sizzle {float_type}",
            # Calculated
            f"opb {float_type}", f"pulse_cohesion {float_type}", f"spectral_slope {float_type}"
        ]

        return {
            'beets': ',\n            '.join(beets_cols),
            'indices': ',\n            '.join(indices_cols)
        }

    def _create_indexes(self):
        """Create database indexes for performance"""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_bt_artist ON music_analysis(bt_artist)",
            "CREATE INDEX IF NOT EXISTS idx_bt_album ON music_analysis(bt_album)",
            "CREATE INDEX IF NOT EXISTS idx_bt_genre ON music_analysis(bt_genre)",
            "CREATE INDEX IF NOT EXISTS idx_bt_year ON music_analysis(bt_year)",
            "CREATE INDEX IF NOT EXISTS idx_bpm ON music_analysis(bpm)",
            "CREATE INDEX IF NOT EXISTS idx_danceability ON music_analysis(danceability)",
            "CREATE INDEX IF NOT EXISTS idx_tonal_clarity ON music_analysis(tonal_clarity)",
            "CREATE INDEX IF NOT EXISTS idx_processed_at ON music_analysis(processed_at)",
            "CREATE INDEX IF NOT EXISTS idx_path_keywords ON music_analysis(path_keywords)",
        ]

        if self.config.use_postgres:
            with self.db.cursor() as cur:
                # Enable trigram extension for fuzzy search
                cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
                logger.info("Enabled pg_trgm extension for fuzzy search")

                # Create standard indexes
                for index_sql in indexes:
                    cur.execute(index_sql)

                # Add fuzzy search GIN index on path_keywords
                cur.execute("""
                    CREATE INDEX IF NOT EXISTS idx_path_keywords_fuzzy
                    ON music_analysis USING GIN (path_keywords gin_trgm_ops)
                """)
                logger.info("Created fuzzy search index on path_keywords")
        else:
            # SQLite - standard indexes only
            for index_sql in indexes:
                self.db.execute(index_sql)

    def _get_placeholder(self, count: int = 1) -> str:
        """Get database-specific parameter placeholder"""
        if self.config.use_postgres:
            return ', '.join([f'%s' for _ in range(count)])
        else:
            return ', '.join(['?' for _ in range(count)])

    def _execute(self, sql: str, params: tuple = ()):    
        """Execute SQL with cursor handling based on database type"""
        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute(sql, params)
                return cur
        else:
            return self.db.execute(sql, params)

    def _column_exists(self, table_name: str, column_name: str) -> bool:
        """Check whether a column exists on a table."""
        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute(
                    """
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name = %s AND column_name = %s
                    """,
                    (table_name, column_name)
                )
                return cur.fetchone() is not None
        else:
            cursor = self.db.execute(f"PRAGMA table_info({table_name})")
            return any(row[1] == column_name for row in cursor.fetchall())

    def track_exists(self, identifier: str) -> bool:
        """Check if track already processed"""
        ph = '%s' if self.config.use_postgres else '?'

        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute(f"SELECT 1 FROM music_analysis WHERE identifier = {ph}", (identifier,))
                return cur.fetchone() is not None
        else:
            cursor = self.db.execute(
                f"SELECT 1 FROM music_analysis WHERE identifier = {ph}",
                (identifier,)
            )
            return cursor.fetchone() is not None

    def insert_track(self, track_data: Dict, indices: Dict):
        """Insert complete track analysis"""
        # Combine all data
        all_data = {'identifier': track_data['identifier']}

        # Add beets metadata with bt_ prefix
        for col in self.beets_columns:
            bt_key = f"bt_{col}"
            all_data[bt_key] = track_data.get(col)

        all_data['path_keywords'] = track_data.get('path_keywords')
        all_data['beets_meta'] = track_data.get('beets_meta')

        # Add indices
        all_data.update(indices)

        # Build insert SQL
        columns = list(all_data.keys())
        ph = '%s' if self.config.use_postgres else '?'
        placeholders = ', '.join([ph for _ in columns])
        values = [all_data[col] for col in columns]

        if self.config.use_postgres:
            # PostgreSQL UPSERT
            update_cols = [col for col in columns if col != 'identifier']
            update_clause = ', '.join([f'{col} = EXCLUDED.{col}' for col in update_cols])
            insert_sql = f"""
            INSERT INTO music_analysis ({', '.join(columns)})
            VALUES ({placeholders})
            ON CONFLICT (identifier) DO UPDATE SET {update_clause}
            """
            with self.db.cursor() as cur:
                cur.execute(insert_sql, values)
        else:
            # SQLite INSERT OR REPLACE
            insert_sql = f"""
            INSERT OR REPLACE INTO music_analysis ({', '.join(columns)})
            VALUES ({placeholders})
            """
            self.db.execute(insert_sql, values)

    def log_error(self, identifier: str, error_type: str, error_message: str):
        """Log processing error"""
        ph = '%s' if self.config.use_postgres else '?'
        sql = f"""
        INSERT INTO processing_log (identifier, status, error_type, error_message)
        VALUES ({ph}, 'failed', {ph}, {ph})
        """
        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute(sql, (identifier, error_type, error_message))
        else:
            self.db.execute(sql, (identifier, error_type, error_message))

    def update_metadata(self, key: str, value: str):
        """Update processing metadata"""
        ph = '%s' if self.config.use_postgres else '?'
        if self.config.use_postgres:
            # PostgreSQL UPSERT
            sql = f"""
            INSERT INTO processing_metadata (key, value)
            VALUES ({ph}, {ph})
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            """
            with self.db.cursor() as cur:
                cur.execute(sql, (key, value))
        else:
            # SQLite INSERT OR REPLACE
            sql = f"""
            INSERT OR REPLACE INTO processing_metadata (key, value)
            VALUES ({ph}, {ph})
            """
            self.db.execute(sql, (key, value))

    def commit(self):
        """Commit database changes"""
        self.db.commit()

    def add_pca_columns(self):
        """Add PCA columns to music_analysis table if they don't exist."""
        logger.info("Adding PCA columns to music_analysis table...")

        pca_columns = [
            'primary_d REAL',
            'tonal_pc1 REAL', 'tonal_pc2 REAL', 'tonal_pc3 REAL',
            'spectral_pc1 REAL', 'spectral_pc2 REAL', 'spectral_pc3 REAL',
            'rhythmic_pc1 REAL', 'rhythmic_pc2 REAL', 'rhythmic_pc3 REAL'
        ]

        for column_def in pca_columns:
            column_name = column_def.split()[0]
            if self._column_exists('music_analysis', column_name):
                continue

            if self.config.use_postgres:
                with self.db.cursor() as cur:
                    cur.execute(f"ALTER TABLE music_analysis ADD COLUMN {column_name} DOUBLE PRECISION")
                logger.info(f"  ✅ Added column: {column_name}")
            else:
                try:
                    self.db.execute(f"ALTER TABLE music_analysis ADD COLUMN {column_def}")
                    logger.info(f"  ✅ Added column: {column_name}")
                except sqlite3.OperationalError:
                    pass  # Column already exists

        # Create indexes
        index_columns = ['primary_d', 'tonal_pc1', 'spectral_pc1', 'rhythmic_pc1']
        if self.config.use_postgres:
            with self.db.cursor() as cur:
                for col in index_columns:
                    cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{col} ON music_analysis({col})")
        else:
            for col in index_columns:
                try:
                    self.db.execute(f"CREATE INDEX IF NOT EXISTS idx_{col} ON music_analysis({col})")
                except Exception:
                    pass

        self.db.commit()
        logger.info("✅ PCA columns ready")

    def create_pca_tables(self):
        """Create pca_transformations and pca_calibration_settings tables."""
        logger.info("Creating PCA metadata tables...")

        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute("""
                CREATE TABLE IF NOT EXISTS pca_transformations (
                    component TEXT NOT NULL,
                    feature_index INTEGER NOT NULL,
                    feature_name TEXT NOT NULL,
                    weight DOUBLE PRECISION NOT NULL,
                    mean DOUBLE PRECISION NOT NULL,
                    scale DOUBLE PRECISION NOT NULL,
                    PRIMARY KEY (component, feature_index)
                )
                """)

                cur.execute("""
                CREATE INDEX IF NOT EXISTS idx_pca_component
                ON pca_transformations(component)
                """)

                cur.execute("""
                CREATE TABLE IF NOT EXISTS pca_calibration_settings (
                    id SERIAL PRIMARY KEY,
                    resolution_level TEXT NOT NULL,
                    discriminator TEXT NOT NULL,
                    base_x DOUBLE PRECISION NOT NULL,
                    inner_radius DOUBLE PRECISION NOT NULL,
                    outer_radius DOUBLE PRECISION NOT NULL,
                    target_percentage DOUBLE PRECISION NOT NULL,
                    achieved_percentage DOUBLE PRECISION NOT NULL,
                    library_size INTEGER NOT NULL,
                    calibration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(resolution_level, discriminator)
                )
                """)
            self.db.commit()
        else:
            # SQLite schema
            self.db.execute("""
            CREATE TABLE IF NOT EXISTS pca_transformations (
                component TEXT NOT NULL,
                feature_index INTEGER NOT NULL,
                feature_name TEXT NOT NULL,
                weight REAL NOT NULL,
                mean REAL NOT NULL,
                scale REAL NOT NULL,
                PRIMARY KEY (component, feature_index)
            )
            """)

            self.db.execute("""
            CREATE INDEX IF NOT EXISTS idx_pca_component
            ON pca_transformations(component)
            """)

            self.db.execute("""
            CREATE TABLE IF NOT EXISTS pca_calibration_settings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                resolution_level TEXT NOT NULL,
                discriminator TEXT NOT NULL,
                base_x REAL NOT NULL,
                inner_radius REAL NOT NULL,
                outer_radius REAL NOT NULL,
                target_percentage REAL NOT NULL,
                achieved_percentage REAL NOT NULL,
                library_size INTEGER NOT NULL,
                calibration_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(resolution_level, discriminator)
            )
            """)

            self.db.commit()
        logger.info("✅ PCA metadata tables ready")

    def insert_pca_transformations(self, weights: List[Tuple]):
        """Bulk insert PCA transformation weights."""
        logger.info(f"Inserting {len(weights)} transformation weights...")

        component_counts = []

        if self.config.use_postgres:
            with self.db.cursor() as cur:
                cur.execute("DELETE FROM pca_transformations")

                insert_sql = """
                INSERT INTO pca_transformations
                (component, feature_index, feature_name, weight, mean, scale)
                VALUES %s
                """
                psycopg2.extras.execute_values(cur, insert_sql, weights, page_size=1000)

            self.db.commit()

            with self.db.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM pca_transformations")
                count = cur.fetchone()[0]
                cur.execute("""
                    SELECT component, COUNT(*)
                    FROM pca_transformations
                    GROUP BY component
                    ORDER BY component
                """)
                component_counts = cur.fetchall()
        else:
            # SQLite
            self.db.execute("DELETE FROM pca_transformations")

            insert_sql = """
            INSERT INTO pca_transformations
            (component, feature_index, feature_name, weight, mean, scale)
            VALUES (?, ?, ?, ?, ?, ?)
            """

            self.db.executemany(insert_sql, weights)
            self.db.commit()

            # Verify
            cursor = self.db.execute("SELECT COUNT(*) FROM pca_transformations")
            count = cursor.fetchone()[0]
            cursor = self.db.execute("""
                SELECT component, COUNT(*)
                FROM pca_transformations
                GROUP BY component
                ORDER BY component
            """)
            component_counts = cursor.fetchall()

        logger.info(f"✅ Inserted {count} transformation weights")

        for component, cnt in component_counts:
            logger.info(f"   {component}: {cnt} weights")

        if count != len(weights):
            raise ValueError(f"Insertion mismatch: expected {len(weights)}, inserted {count}")

    def batch_update_pca_values(self, pca_computer):
        """Batch update PCA values for all tracks."""
        logger.info("Updating PCA values for all tracks...")

        n_tracks = len(pca_computer.data)
        batch_size = 1000

        for i in range(0, n_tracks, batch_size):
            batch_end = min(i + batch_size, n_tracks)
            batch_updates = []

            for j in range(i, batch_end):
                row = pca_computer.data.iloc[j]
                identifier = row['identifier']

                # Extract PCA values from fitted models
                primary_d_val = float(pca_computer.discriminators['primary_d']['values'][j])
                tonal_vals = pca_computer.discriminators['tonal']['values'][j]
                spectral_vals = pca_computer.discriminators['spectral']['values'][j]
                rhythmic_vals = pca_computer.discriminators['rhythmic']['values'][j]

                update_values = (
                    primary_d_val,
                    float(tonal_vals[0]), float(tonal_vals[1]), float(tonal_vals[2]),
                    float(spectral_vals[0]), float(spectral_vals[1]), float(spectral_vals[2]),
                    float(rhythmic_vals[0]), float(rhythmic_vals[1]), float(rhythmic_vals[2]),
                    identifier
                )
                batch_updates.append(update_values)

            ph = '%s' if self.config.use_postgres else '?'
            update_sql = f"""
            UPDATE music_analysis SET
                primary_d = {ph}, tonal_pc1 = {ph}, tonal_pc2 = {ph}, tonal_pc3 = {ph},
                spectral_pc1 = {ph}, spectral_pc2 = {ph}, spectral_pc3 = {ph},
                rhythmic_pc1 = {ph}, rhythmic_pc2 = {ph}, rhythmic_pc3 = {ph}
            WHERE identifier = {ph}
            """

            if self.config.use_postgres:
                with self.db.cursor() as cur:
                    psycopg2.extras.execute_batch(cur, update_sql, batch_updates, page_size=1000)
            else:
                self.db.executemany(update_sql, batch_updates)

            if (i + batch_size) % 10000 == 0:
                logger.info(f"  Updated {i + batch_size:,}/{n_tracks:,} tracks...")

        self.db.commit()
        logger.info(f"✅ Updated {n_tracks:,} tracks with PCA values")

    def insert_calibration_settings(self, calibration_results: Dict):
        """Insert calibration settings into database."""
        logger.info("Inserting calibration settings...")

        ph = '%s' if self.config.use_postgres else '?'

        if self.config.use_postgres:
            with self.db.cursor() as cur:
                # Clear existing settings
                cur.execute("DELETE FROM pca_calibration_settings")

                # Get library size
                cur.execute("SELECT COUNT(*) FROM music_analysis")
                library_size = cur.fetchone()[0]

                settings = []
                for resolution_name, resolution_data in calibration_results.items():
                    target_pct = float(resolution_data['config']['target_pct'])

                    for disc_name, disc_results in resolution_data['discriminator_calibrations'].items():
                        settings.append((
                            resolution_name,
                            disc_name,
                            float(disc_results['best_x']),
                            float(disc_results['best_inner']),
                            float(disc_results['best_outer']),
                            target_pct,
                            float(disc_results['achieved_percentage']),
                            int(library_size)
                        ))

                # Use execute_values for bulk insert
                insert_sql = """
                INSERT INTO pca_calibration_settings
                (resolution_level, discriminator, base_x, inner_radius, outer_radius,
                 target_percentage, achieved_percentage, library_size)
                VALUES %s
                """
                psycopg2.extras.execute_values(cur, insert_sql, settings, page_size=1000)
        else:
            # SQLite
            self.db.execute("DELETE FROM pca_calibration_settings")

            insert_sql = f"""
            INSERT INTO pca_calibration_settings
            (resolution_level, discriminator, base_x, inner_radius, outer_radius,
             target_percentage, achieved_percentage, library_size)
            VALUES ({ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph}, {ph})
            """

            # Get library size
            cursor = self.db.execute("SELECT COUNT(*) FROM music_analysis")
            library_size = cursor.fetchone()[0]

            settings = []
            for resolution_name, resolution_data in calibration_results.items():
                target_pct = float(resolution_data['config']['target_pct'])

                for disc_name, disc_results in resolution_data['discriminator_calibrations'].items():
                    settings.append((
                        resolution_name,
                        disc_name,
                        float(disc_results['best_x']),
                        float(disc_results['best_inner']),
                        float(disc_results['best_outer']),
                        target_pct,
                        float(disc_results['achieved_percentage']),
                        int(library_size)
                    ))

            self.db.executemany(insert_sql, settings)
        self.db.commit()

        logger.info(f"✅ Inserted {len(settings)} calibration settings")

    def close(self):
        """Close database connection"""
        if self.db:
            self.db.close()

class Beets2TsnotProcessor:
    """Main processor orchestrating the complete pipeline"""

    def __init__(self, config: ProcessingConfig):
        self.config = config
        self.beets_extractor = BeetsMetadataExtractor(config.beets_db_path)
        self.essentia_processor = EssentiaProcessor(config)
        self.feature_processor = FeatureProcessor()
        self.db_manager = DatabaseManager(config)

        # Processing statistics
        self.stats = {
            'start_time': time.time(),
            'processed': 0,
            'skipped': 0,
            'failed': 0,
            'total': 0
        }

    def initialize(self):
        """Initialize the processing pipeline"""
        logger.info("Initializing beets2tsnot pipeline...")

        # Get beets schema
        beets_columns = self.beets_extractor.get_all_columns()

        # Initialize output database
        self.db_manager.initialize_schema(beets_columns)

        # Record processing metadata
        self.db_manager.update_metadata('tranche', self.config.tranche)
        self.db_manager.update_metadata('beets_db_path', self.config.beets_db_path)
        self.db_manager.update_metadata('parallel_jobs', str(self.config.parallel_jobs))

        logger.info("Pipeline initialization complete")

    def process_all(self):
        """Process all tracks based on configuration"""
        # Get tracks to process
        tracks = self.beets_extractor.get_tracks(self.config)
        self.stats['total'] = len(tracks)

        if not tracks:
            logger.warning("No tracks found matching criteria")
            return

        logger.info(f"Starting processing of {len(tracks)} tracks (tranche: {self.config.tranche})")

        if self.config.dry_run:
            logger.info("DRY RUN: Would process the following tracks:")
            for i, track in enumerate(tracks[:10]):  # Show first 10
                logger.info(f"  {i+1}: {track.get('bt_artist', 'Unknown')} - {track.get('bt_title', 'Unknown')}")
            if len(tracks) > 10:
                logger.info(f"  ... and {len(tracks) - 10} more tracks")
            return

        # Process tracks
        if self.config.parallel_jobs == 1:
            self._process_sequential(tracks)
        else:
            self._process_parallel(tracks)

        # Final statistics and cleanup
        self._finalize_processing()

    def _process_sequential(self, tracks: List[Dict]):
        """Process tracks sequentially"""
        for i, track in enumerate(tracks):
            try:
                self._process_single_track(track)

                # Progress reporting
                if (i + 1) % 50 == 0:
                    self._report_progress(i + 1, len(tracks))

            except KeyboardInterrupt:
                logger.info("Processing interrupted by user")
                break
            except Exception as e:
                logger.error(f"Unexpected error processing track {track['identifier']}: {e}")
                self.stats['failed'] += 1

        self.db_manager.commit()

    def _process_parallel(self, tracks: List[Dict]):
        """Process tracks in parallel"""
        batch_size = self.config.batch_size

        for batch_start in range(0, len(tracks), batch_size):
            batch = tracks[batch_start:batch_start + batch_size]

            with ThreadPoolExecutor(max_workers=self.config.parallel_jobs) as executor:
                # Submit batch
                future_to_track = {
                    executor.submit(self._process_single_track, track): track
                    for track in batch
                }

                # Collect results
                for future in as_completed(future_to_track):
                    track = future_to_track[future]
                    try:
                        future.result()
                    except Exception as e:
                        logger.error(f"Error in parallel processing for {track['identifier']}: {e}")
                        self.stats['failed'] += 1

            # Commit batch
            self.db_manager.commit()

            # Progress reporting
            processed_so_far = min(batch_start + batch_size, len(tracks))
            self._report_progress(processed_so_far, len(tracks))

    def _process_single_track(self, track: Dict) -> bool:
        """Process a single track through the complete pipeline"""
        identifier = track['identifier']

        try:
            # Skip if resuming and already processed
            if self.config.resume and self.db_manager.track_exists(identifier):
                self.stats['skipped'] += 1
                return True

            # Extract Essentia features
            features, error_info = self.essentia_processor.extract_features(track['path_str'], identifier)
            if not features:
                error_type = 'extraction_failed'
                error_message = 'Essentia feature extraction failed'

                if error_info:
                    error_type = error_info.get('type', error_type)
                    error_message = error_info.get('message', error_message)

                self.db_manager.log_error(identifier, error_type, error_message)
                self.stats['failed'] += 1
                return False

            # Process features
            flattened_features = self.feature_processor.flatten_essentia_features(features)
            indices = self.feature_processor.extract_indices(flattened_features)

            # Insert into database
            self.db_manager.insert_track(track, indices)

            self.stats['processed'] += 1

            return True

        except Exception as e:
            logger.error(f"Error processing {identifier}: {e}")
            if self.config.verbose:
                logger.error(traceback.format_exc())
            self.db_manager.log_error(identifier, 'processing_error', str(e))
            self.stats['failed'] += 1
            return False

    def _report_progress(self, current: int, total: int):
        """Report processing progress"""
        elapsed = time.time() - self.stats['start_time']
        rate = current / elapsed * 60 if elapsed > 0 else 0
        eta = (total - current) / rate * 60 if rate > 0 else 0

        logger.info(
            f"Progress: {current}/{total} ({current/total*100:.1f}%) | "
            f"Rate: {rate:.1f} tracks/min | "
            f"ETA: {eta/60:.0f}m | "
            f"Success: {self.stats['processed']}, "
            f"Skipped: {self.stats['skipped']}, "
            f"Failed: {self.stats['failed']}"
        )

    def _finalize_processing(self):
        """Finalize processing with statistics and cleanup"""
        elapsed = time.time() - self.stats['start_time']

        # Update final metadata
        self.db_manager.update_metadata('processing_completed', str(time.time()))
        self.db_manager.update_metadata('tracks_processed', str(self.stats['processed']))
        self.db_manager.update_metadata('tracks_failed', str(self.stats['failed']))
        self.db_manager.update_metadata('processing_time_seconds', str(elapsed))

        self.db_manager.commit()

        # Final statistics
        logger.info("=" * 60)
        logger.info("BEETS2TSNOT PROCESSING COMPLETE")
        logger.info(f"Tranche: {self.config.tranche}")
        logger.info(f"Runtime: {elapsed:.1f} seconds ({elapsed/60:.1f} minutes)")
        logger.info(f"Total tracks: {self.stats['total']}")
        logger.info(f"Processed: {self.stats['processed']}")
        logger.info(f"Skipped: {self.stats['skipped']}")
        logger.info(f"Failed: {self.stats['failed']}")

        if self.stats['processed'] > 0:
            rate = self.stats['processed'] / elapsed * 60
            logger.info(f"Processing rate: {rate:.1f} tracks/minute")

        success_rate = self.stats['processed'] / max(self.stats['total'] - self.stats['skipped'], 1) * 100
        logger.info(f"Success rate: {success_rate:.1f}%")

        logger.info(f"Output database: {self.config.output_db_path}")
        logger.info("=" * 60)

    def cleanup(self):
        """Cleanup resources"""
        self.beets_extractor.close()
        self.db_manager.close()

def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(
        description="beets2tsnot.py - Ultimate Single-Dependency Music Analysis Pipeline",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Proof of tools (100 tracks)
  python beets2tsnot.py --beets-db ~/.config/beets/library.db --tranche proof_tools

  # Proof of app (1,000 tracks)
  python beets2tsnot.py --beets-db ~/.config/beets/library.db --tranche proof_app

  # Custom processing
  python beets2tsnot.py --beets-db ~/.config/beets/library.db --limit 500 --genre rock

  # High performance
  python beets2tsnot.py --beets-db ~/.config/beets/library.db --parallel 8 --tranche make_fun
        """
    )

    # Required arguments
    parser.add_argument('--beets-db', default='~/.config/beets/library.db',
                       help='Path to beets database (default: ~/.config/beets/library.db)')

    # Processing strategy
    parser.add_argument('--tranche', choices=list(TRANCHE_SIZES.keys()), default='proof_tools',
                       help='Processing tranche size (default: proof_tools)')
    parser.add_argument('--limit', type=int,
                       help='Custom limit (overrides tranche)')
    parser.add_argument('--offset', type=int, default=0,
                       help='Offset for batch processing')

    # Output options
    parser.add_argument('--output', default='tsnot_analysis.db',
                       help='Output database path')
    parser.add_argument('--checkpoint-db',
                       help='Checkpoint database for resumable processing')

    # PostgreSQL options
    parser.add_argument('--postgres', action='store_true',
                       help='Use PostgreSQL instead of SQLite')
    parser.add_argument('--pg-host', default='localhost',
                       help='PostgreSQL host (default: localhost)')
    parser.add_argument('--pg-port', type=int, default=5432,
                       help='PostgreSQL port (default: 5432)')
    parser.add_argument('--pg-database', default='tsnotfyi',
                       help='PostgreSQL database name (default: tsnotfyi)')
    parser.add_argument('--pg-user', default='postgres',
                       help='PostgreSQL user (default: postgres)')
    parser.add_argument('--pg-password',
                       help='PostgreSQL password (or use PGPASSWORD env var)')

    # Performance tuning
    parser.add_argument('--parallel', type=int, default=4,
                       help='Number of parallel jobs')
    parser.add_argument('--chunk-size', type=int, default=20,
                       help='Chunk size for processing')
    parser.add_argument('--batch-size', type=int, default=100,
                       help='Batch size for database operations')
    parser.add_argument('--timeout', type=int, default=600,
                       help='Essentia timeout in seconds')

    # Filtering options
    parser.add_argument('--genre', help='Filter by genre')
    parser.add_argument('--year-range', help='Year range filter (e.g., 1970-2000)')
    parser.add_argument('--format', help='Audio format filter')
    parser.add_argument('--path', dest='paths', action='append',
                       help='Exact beets path to process (can repeat)')
    parser.add_argument('--path-prefix', dest='path_prefixes', action='append',
                       help='Only process tracks whose path starts with this prefix (can repeat)')

    # Processing options
    parser.add_argument('--no-resume', action='store_true',
                       help='Disable resuming from previous run')
    parser.add_argument('--no-validate-files', action='store_true',
                       help='Skip file existence validation')
    parser.add_argument('--include-failed', action='store_true',
                       help='Include previously failed tracks')

    # Debug options
    parser.add_argument('--verbose', action='store_true',
                       help='Verbose logging')
    parser.add_argument('--dry-run', action='store_true',
                       help='Show what would be processed without doing it')

    args = parser.parse_args()

    # Configure logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Parse year range
    year_range = None
    if args.year_range:
        try:
            start, end = map(int, args.year_range.split('-'))
            year_range = (start, end)
        except ValueError:
            logger.error("Year range must be in format: START-END (e.g., 1970-2000)")
            sys.exit(1)

    # Build configuration
    config = ProcessingConfig(
        beets_db_path=os.path.expanduser(args.beets_db),
        output_db_path=args.output,
        checkpoint_db_path=args.checkpoint_db,
        tranche=args.tranche,
        limit=args.limit,
        offset=args.offset,
        parallel_jobs=args.parallel,
        chunk_size=args.chunk_size,
        batch_size=args.batch_size,
        essentia_timeout=args.timeout,
        genre_filter=args.genre,
        year_range=year_range,
        format_filter=args.format,
        paths=[os.path.expanduser(p) for p in args.paths] if args.paths else None,
        path_prefixes=[os.path.expanduser(p) for p in args.path_prefixes] if args.path_prefixes else None,
        resume=not args.no_resume,
        validate_files=not args.no_validate_files,
        include_failed=args.include_failed,
        verbose=args.verbose,
        dry_run=args.dry_run,
        # PostgreSQL options
        use_postgres=args.postgres,
        pg_host=args.pg_host,
        pg_port=args.pg_port,
        pg_database=args.pg_database,
        pg_user=args.pg_user,
        pg_password=args.pg_password
    )

    # Validate beets database exists
    if not Path(config.beets_db_path).exists():
        logger.error(f"Beets database not found: {config.beets_db_path}")
        sys.exit(1)

    # Check for Essentia
    if not args.dry_run:
        try:
            result = subprocess.run(['/opt/homebrew/bin/essentia_streaming_extractor_music', '--help'],
                                  capture_output=True)
            # Essentia returns exit code 1 for --help, check if binary exists instead
            if result.returncode == 127:  # Command not found
                raise FileNotFoundError()
        except FileNotFoundError:
            logger.error("essentia_streaming_extractor_music not found at /opt/homebrew/bin/")
            logger.error("Install Essentia: brew install essentia (macOS) or equivalent")
            sys.exit(1)

    # Run pipeline
    processor = Beets2TsnotProcessor(config)

    try:
        processor.initialize()
        processor.process_all()

        if config.dry_run:
            return

        # STAGE 3: PCA COMPUTATION AND CALIBRATION
        logger.info("=" * 80)
        logger.info("STAGE 3: PCA COMPUTATION AND CALIBRATION")
        logger.info("=" * 80)

        try:
            # 1. Create PCA tables
            processor.db_manager.create_pca_tables()
            processor.db_manager.add_pca_columns()

            # 2. Initialize PCA computer and fit models
            pca_computer = PCAComputer()
            pca_computer.fit_pca_on_library(config)

            # 3. Extract and store transformation weights
            weights = pca_computer.extract_transformation_weights()
            processor.db_manager.insert_pca_transformations(weights)

            # 4. Update all tracks with PCA values
            processor.db_manager.batch_update_pca_values(pca_computer)

            # 5. Calibrate resolution controls
            calibration_results = pca_computer.calibrate_resolution_controls()
            processor.db_manager.insert_calibration_settings(calibration_results)

            # 6. Validate integrity
            pca_computer.validate_pca_integrity(processor.db_manager)

            logger.info("\n" + "=" * 80)
            logger.info("✅ PCA COMPUTATION COMPLETE")
            logger.info("=" * 80)
            logger.info("   - 72 transformation weights stored")
            logger.info("   - 12 calibration settings computed")
            logger.info("   - All values validated")
            logger.info(f"   - Database ready: {config.output_db_path}")

        except Exception as e:
            logger.error(f"❌ PCA computation failed: {e}")
            if config.verbose:
                logger.error(traceback.format_exc())
            raise RuntimeError("PCA computation failed - import incomplete")

    except KeyboardInterrupt:
        logger.info("Processing interrupted by user")
        sys.exit(130)
    except Exception as e:
        logger.error(f"Pipeline failed: {e}")
        if config.verbose:
            logger.error(traceback.format_exc())
        sys.exit(1)
    finally:
        processor.cleanup()

if __name__ == '__main__':
    main()
