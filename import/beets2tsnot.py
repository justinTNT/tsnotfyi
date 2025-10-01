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

    # Debug options
    verbose: bool = False
    dry_run: bool = False

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

            # Add computed fields
            track_data['identifier'] = identifier
            track_data['path_str'] = path

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

    def extract_features(self, track_path: str, track_id: str) -> Optional[Dict]:
        """Extract Essentia features from audio file"""
        try:
            # Validate file exists if enabled
            if self.config.validate_files:
                if not Path(track_path).exists():
                    logger.warning(f"File not found: {track_path}")
                    self._record_error('file_not_found', track_id)
                    return None

            # Create temporary file for Essentia output
            with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as tmp:
                tmp_path = tmp.name

            try:
                # Run Essentia extractor
                cmd = [
                    '/opt/homebrew/bin/essentia_streaming_extractor_music',
                    track_path,
                    tmp_path
                ]

                result = subprocess.run(
                    cmd,
                    timeout=self.config.essentia_timeout,
                    capture_output=True,
                    text=True
                )

                if result.returncode != 0:
                    logger.error(f"Essentia failed for {track_id}: {result.stderr[:200]}")
                    self._record_error('essentia_failed', track_id)
                    return None

                # Read and parse results
                with open(tmp_path, 'r', encoding='utf-8') as f:
                    features = json.load(f)
                return features

            finally:
                # Cleanup temporary file
                Path(tmp_path).unlink(missing_ok=True)

        except subprocess.TimeoutExpired:
            logger.error(f"Essentia timeout for {track_id} (>{self.config.essentia_timeout}s)")
            self._record_error('timeout', track_id)
            return None

        except json.JSONDecodeError as e:
            logger.error(f"JSON parsing failed for {track_id}: {e}")
            self._record_error('json_parse', track_id)
            return None

        except Exception as e:
            logger.error(f"Unexpected error extracting features for {track_id}: {e}")
            self._record_error('unexpected', track_id)
            return None

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
        self.db = sqlite3.connect(self.db_path, timeout=30.0, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self.db.execute("PRAGMA cache_size=10000")
        logger.info(f"Connected to output database: {self.db_path}")

    def initialize_schema(self, beets_columns: List[str]):
        """Initialize database schema with beets metadata integration"""
        self.beets_columns = beets_columns

        # Create main analysis table
        columns_sql = self._build_columns_sql()

        create_sql = f"""
        CREATE TABLE IF NOT EXISTS music_analysis (
            identifier TEXT PRIMARY KEY,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

            -- Beets metadata (bt_ prefix)
            {columns_sql['beets']},

            -- Music indices (21 total)
            {columns_sql['indices']}
        )
        """

        self.db.execute(create_sql)

        # Create metadata table
        self.db.execute("""
        CREATE TABLE IF NOT EXISTS processing_metadata (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Create processing log table
        self.db.execute("""
        CREATE TABLE IF NOT EXISTS processing_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            identifier TEXT,
            status TEXT,
            error_type TEXT,
            error_message TEXT,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """)

        # Create indexes
        self._create_indexes()

        self.db.commit()
        logger.info("Database schema initialized")

    def _build_columns_sql(self) -> Dict[str, str]:
        """Build SQL column definitions"""

        # Beets metadata columns with bt_ prefix
        beets_cols = []
        for col in self.beets_columns:
            if col == 'id':
                beets_cols.append(f"bt_id INTEGER")
            elif col in ['path']:
                beets_cols.append(f"bt_{col} TEXT")
            elif col in ['length', 'mtime', 'added', 'rg_track_gain', 'rg_track_peak', 'rg_album_gain', 'rg_album_peak', 'r128_track_gain', 'r128_album_gain']:
                beets_cols.append(f"bt_{col} REAL")
            elif col in ['year', 'month', 'day', 'track', 'tracktotal', 'disc', 'disctotal', 'comp', 'bitrate', 'samplerate', 'bitdepth', 'channels', 'original_year', 'original_month', 'original_day', 'bpm']:
                beets_cols.append(f"bt_{col} INTEGER")
            else:
                beets_cols.append(f"bt_{col} TEXT")

        # Music indices columns
        indices_cols = [
            # Rhythmic
            "bpm REAL", "danceability REAL", "onset_rate REAL", "beat_punch REAL",
            # Tonal
            "tonal_clarity REAL", "tuning_purity REAL", "fifths_strength REAL",
            "chord_strength REAL", "chord_change_rate REAL",
            # Harmonic
            "crest REAL", "entropy REAL",
            # Spectral
            "spectral_centroid REAL", "spectral_rolloff REAL", "spectral_kurtosis REAL",
            "spectral_energy REAL", "spectral_flatness REAL",
            # Production
            "sub_drive REAL", "air_sizzle REAL",
            # Calculated
            "opb REAL", "pulse_cohesion REAL", "spectral_slope REAL"
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
        ]

        for index_sql in indexes:
            self.db.execute(index_sql)

    def track_exists(self, identifier: str) -> bool:
        """Check if track already processed"""
        cursor = self.db.execute(
            "SELECT 1 FROM music_analysis WHERE identifier = ?",
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

        # Add indices
        all_data.update(indices)

        # Build insert SQL
        columns = list(all_data.keys())
        placeholders = ', '.join(['?' for _ in columns])
        values = [all_data[col] for col in columns]

        insert_sql = f"""
        INSERT OR REPLACE INTO music_analysis ({', '.join(columns)})
        VALUES ({placeholders})
        """

        self.db.execute(insert_sql, values)

    def log_error(self, identifier: str, error_type: str, error_message: str):
        """Log processing error"""
        self.db.execute("""
        INSERT INTO processing_log (identifier, status, error_type, error_message)
        VALUES (?, 'failed', ?, ?)
        """, (identifier, error_type, error_message))

    def update_metadata(self, key: str, value: str):
        """Update processing metadata"""
        self.db.execute("""
        INSERT OR REPLACE INTO processing_metadata (key, value)
        VALUES (?, ?)
        """, (key, value))

    def commit(self):
        """Commit database changes"""
        self.db.commit()

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
            features = self.essentia_processor.extract_features(track['path_str'], identifier)
            if not features:
                self.db_manager.log_error(identifier, 'extraction_failed', 'Essentia feature extraction failed')
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
        resume=not args.no_resume,
        validate_files=not args.no_validate_files,
        include_failed=args.include_failed,
        verbose=args.verbose,
        dry_run=args.dry_run
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