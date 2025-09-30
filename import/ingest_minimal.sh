#!/bin/bash
# ingest_minimal.sh - Absolute minimal overhead approach using base64

set -euo pipefail

# Configuration
BEETS_DB="$HOME/.config/beets/library.db"
RESULTS_DB="$(pwd)/results.db"
TEMP_DIR="/tmp/music_ingest_minimal"
LOG_FILE="ingest_minimal.log"
PARALLEL_JOBS=6
CHUNK_SIZE=6
VERBOSE=false

DEFAULT_BEETS_META='{"item":null,"album":null,"item_attributes":{},"album_attributes":{}}'
ITEM_JSON_EXPR=""
ALBUM_JSON_EXPR=""

# Parse arguments
LIMIT=""
OFFSET=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --limit) LIMIT="$2"; shift 2 ;;
        --offset) OFFSET="$2"; shift 2 ;;
        --parallel) PARALLEL_JOBS="$2"; shift 2 ;;
        --chunk-size) CHUNK_SIZE="$2"; shift 2 ;;
        --verbose) VERBOSE=true; shift ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Auto-calculate offset
if [[ -z "$OFFSET" ]]; then
    OFFSET=$(sqlite3 "$RESULTS_DB" "SELECT COUNT(*) FROM tracks" 2>/dev/null || echo "0")
fi

# Setup
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# Counters (only in verbose mode)
if [[ "$VERBOSE" == "true" ]]; then
    TOTAL_FILE="$TEMP_DIR/total"
    SUCCESS_FILE="$TEMP_DIR/success"
    FAILED_FILE="$TEMP_DIR/failed"
    SKIPPED_FILE="$TEMP_DIR/skipped"

    echo "0" > "$TOTAL_FILE"
    echo "0" > "$SUCCESS_FILE"
    echo "0" > "$FAILED_FILE"
    echo "0" > "$SKIPPED_FILE"
else
    # Define empty variables to avoid unbound variable errors
    TOTAL_FILE=""
    SUCCESS_FILE=""
    FAILED_FILE=""
    SKIPPED_FILE=""
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

increment_counter() {
    if [[ "$VERBOSE" == "true" && -n "${1:-}" ]]; then
        echo "$(($(cat "$1") + 1))" > "$1"
    fi
}

ensure_column_exists() {
    local column="$1"
    local definition="$2"
    local exists
    exists=$(sqlite3 "$RESULTS_DB" "SELECT 1 FROM pragma_table_info('tracks') WHERE name='$column' LIMIT 1;" 2>/dev/null || true)
    if [[ -z "$exists" ]]; then
        sqlite3 "$RESULTS_DB" "ALTER TABLE tracks ADD COLUMN $column $definition;"
    fi
}

prepare_beets_meta_helpers() {
    if [[ -n "$ITEM_JSON_EXPR" && -n "$ALBUM_JSON_EXPR" ]]; then
        return
    fi

    ITEM_JSON_EXPR=$(sqlite3 "$BEETS_DB" "SELECT 'json_object(' || group_concat(printf('''%s'',%s', name, CASE WHEN instr(upper(type), 'BLOB') > 0 THEN 'CASE WHEN ' || name || ' IS NULL THEN NULL ELSE CAST(' || name || ' AS TEXT) END' ELSE name END), ', ') || ')' FROM pragma_table_info('items');" 2>/dev/null || true)
    ITEM_JSON_EXPR=${ITEM_JSON_EXPR//$'
'/ }

    ALBUM_JSON_EXPR=$(sqlite3 "$BEETS_DB" "SELECT 'json_object(' || group_concat(printf('''%s'',%s', name, CASE WHEN instr(upper(type), 'BLOB') > 0 THEN 'CASE WHEN ' || name || ' IS NULL THEN NULL ELSE CAST(' || name || ' AS TEXT) END' ELSE name END), ', ') || ')' FROM pragma_table_info('albums');" 2>/dev/null || true)
    ALBUM_JSON_EXPR=${ALBUM_JSON_EXPR//$'
'/ }

    if [[ -z "$ITEM_JSON_EXPR" || -z "$ALBUM_JSON_EXPR" ]]; then
        log "WARN: Unable to build beets meta expressions; falling back to minimal metadata"
        ITEM_JSON_EXPR=""
        ALBUM_JSON_EXPR=""
    fi
}

generate_beets_meta() {
    local item_id="$1"
    if [[ -z "$item_id" ]]; then
        printf '%s' "$DEFAULT_BEETS_META"
        return
    fi

    if [[ -z "$ITEM_JSON_EXPR" || -z "$ALBUM_JSON_EXPR" ]]; then
        printf '%s' "$DEFAULT_BEETS_META"
        return
    fi

    local sql
    sql=$(cat <<SQL
WITH item_row AS (
    SELECT $ITEM_JSON_EXPR AS data, album_id
    FROM items
    WHERE id = $item_id
),
album_row AS (
    SELECT $ALBUM_JSON_EXPR AS data
    FROM albums
    WHERE id = (SELECT album_id FROM items WHERE id = $item_id)
),
item_attrs AS (
    SELECT COALESCE(json_group_object(key, value), '{}') AS data
    FROM item_attributes
    WHERE entity_id = $item_id
),
album_attrs AS (
    SELECT COALESCE(json_group_object(key, value), '{}') AS data
    FROM album_attributes
    WHERE entity_id = (SELECT album_id FROM items WHERE id = $item_id)
)
SELECT json_object(
    'item', (SELECT json(data) FROM item_row),
    'album', (SELECT json(data) FROM album_row),
    'item_attributes', json(COALESCE((SELECT data FROM item_attrs), '{}')),
    'album_attributes', json(COALESCE((SELECT data FROM album_attrs), '{}'))
);
SQL
)

    local result
    result=$(sqlite3 "$BEETS_DB" "$sql" 2>/dev/null || true)
    result=${result//$'
'/}
    if [[ -z "$result" || "$result" == "NULL" ]]; then
        printf '%s' "$DEFAULT_BEETS_META"
    else
        printf '%s' "$result"
    fi
}

# Initialize database with base64-encoded fields
init_results_db() {
    sqlite3 "$RESULTS_DB" "
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA cache_size=10000;
    CREATE TABLE IF NOT EXISTS tracks (
        identifier TEXT PRIMARY KEY,
        path_b64 TEXT NOT NULL,
        beets_json_b64 TEXT NOT NULL,
        essentia_json_b64 TEXT NOT NULL,
        love REAL NOT NULL DEFAULT 0,
        hate REAL NOT NULL DEFAULT 0,
        beets_meta TEXT,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_identifier ON tracks(identifier);
    "

    ensure_column_exists "love" "REAL NOT NULL DEFAULT 0"
    ensure_column_exists "hate" "REAL NOT NULL DEFAULT 0"
    ensure_column_exists "beets_meta" "TEXT"
}

get_tracks_from_db() {
    local sql="SELECT id, artist, title, album, year, path FROM items WHERE path IS NOT NULL"
    if [[ -n "$LIMIT" ]]; then
        sql="$sql LIMIT $LIMIT OFFSET $OFFSET"
    fi
    sqlite3 "$BEETS_DB" -separator '|' "$sql"
}

process_track_minimal() {
    local db_id="$1" artist="$2" title="$3" album="$4" year="$5" path="$6"

    local identifier=$(echo -n "$path" | md5)
    increment_counter "$TOTAL_FILE"

    # Fast skip check with retry logic
    local skip_check_result=""
    for attempt in {1..3}; do
        if skip_check_result=$(sqlite3 "$RESULTS_DB" "SELECT 1 FROM tracks WHERE identifier='$identifier'" 2>/dev/null); then
            break
        else
            sleep $(awk "BEGIN {print rand() * 0.1}")  # Random delay 0-100ms
        fi
    done

    if [[ "$skip_check_result" == "1" ]]; then
        increment_counter "$SKIPPED_FILE"
        return 0
    fi

    # Run essentia
    local essentia_file="$TEMP_DIR/e_${identifier}_$$.json"
    if ! gtimeout 600 essentia_streaming_extractor_music "$path" "$essentia_file" >/dev/null 2>&1 || [[ ! -f "$essentia_file" ]]; then
        log "FAILED essentia: $identifier | $path"
        increment_counter "$FAILED_FILE"
        rm -f "$essentia_file"
        return 1
    fi

    # Create beets JSON (minimal)
    local beets_json="{\"artist\":\"$artist\",\"title\":\"$title\",\"album\":\"$album\",\"year\":$([[ -n "$year" && "$year" != "" ]] && echo "$year" || echo "null"),\"path\":\"$path\"}"

    # Base64 encode everything - fast and handles all characters
    local path_b64=$(printf '%s' "$path" | base64)
    local beets_b64=$(printf '%s' "$beets_json" | base64)
    local essentia_b64=$(base64 < "$essentia_file")
    local beets_meta_json
    beets_meta_json=$(generate_beets_meta "$db_id")
    if [[ -z "$beets_meta_json" ]]; then
        beets_meta_json="$DEFAULT_BEETS_META"
    fi
    beets_meta_json=${beets_meta_json//$'
'/}
    local beets_meta_sql=${beets_meta_json//\'/\'\'}

    # SQLite insertion with retry logic for database locks
    local insert_success=false
    for attempt in {1..5}; do
        if sqlite3 "$RESULTS_DB" "INSERT INTO tracks (identifier, path_b64, beets_json_b64, essentia_json_b64, love, hate, beets_meta) VALUES ('$identifier', '$path_b64', '$beets_b64', '$essentia_b64', 0, 0, '$beets_meta_sql');" 2>/dev/null; then
            insert_success=true
            break
        else
            local delay=$(awk "BEGIN {print rand() * 0.5}")  # Random delay 0-500ms
            sleep "$delay"
            log "SQLite retry $attempt/5: $identifier"
        fi
    done

    if [[ "$insert_success" == "true" ]]; then
        increment_counter "$SUCCESS_FILE"
    else
        log "FAILED sqlite-insert (all retries): $identifier | $path"
        increment_counter "$FAILED_FILE"
    fi

    rm -f "$essentia_file"
    return 0
}

worker() {
    local worker_id="$1" queue_file="$2"
    log "Worker $worker_id started"

    while IFS='|' read -r db_id artist title album year path || [[ -n "$db_id" ]]; do
        [[ -n "$path" ]] || continue
        process_track_minimal "$db_id" "$artist" "$title" "$album" "$year" "$path" || true
    done < "$queue_file"

    log "Worker $worker_id finished"
}

progress_monitor() {
    local start_time="$1"
    local start_timestamp="$2"

    while true; do
        sleep 30
        local elapsed=$(($(date +%s) - start_time))
        [[ $elapsed -eq 0 ]] && elapsed=1

        if [[ "$VERBOSE" == "true" ]]; then
            # Detailed verbose progress with file counters
            local total=$(cat "$TOTAL_FILE" 2>/dev/null || echo "0")
            local success=$(cat "$SUCCESS_FILE" 2>/dev/null || echo "0")
            local failed=$(cat "$FAILED_FILE" 2>/dev/null || echo "0")
            local skipped=$(cat "$SKIPPED_FILE" 2>/dev/null || echo "0")
            local rate=0
            [[ $total -gt 0 ]] && rate=$((total * 3600 / elapsed))
            log "Progress: $total total, $success new, $skipped skipped, $failed failed ($rate tracks/hour)"
        else
            # Fast progress using database query only
            # Debug: check total records and recent records
            local db_total=$(sqlite3 "$RESULTS_DB" "SELECT COUNT(*) FROM tracks" 2>/dev/null || echo "0")
            local db_count=$(sqlite3 "$RESULTS_DB" "SELECT COUNT(*) FROM tracks WHERE datetime(processed_at) >= datetime('$start_timestamp')" 2>/dev/null || echo "0")
            local rate=0
            [[ $db_count -gt 0 ]] && rate=$((db_count * 3600 / elapsed))
            log "Progress: $db_count new tracks (total: $db_total, $rate tracks/hour)"
        fi

        if ! pgrep -f "essentia_streaming_extractor_music" >/dev/null; then
            sleep 60
            if ! pgrep -f "essentia_streaming_extractor_music" >/dev/null; then
                break
            fi
        fi
    done
}

main() {
    log "=== MINIMAL MUSIC INGESTION ==="
    log "Parallel jobs: $PARALLEL_JOBS, Limit: ${LIMIT:-unlimited}, Offset: $OFFSET"

    init_results_db

    # Validate essentials
    for cmd in essentia_streaming_extractor_music sqlite3 gtimeout md5 base64; do
        command -v "$cmd" >/dev/null || { log "FATAL: $cmd not found"; exit 1; }
    done

    [[ -f "$BEETS_DB" ]] || { log "FATAL: Beets database not found"; exit 1; }

    prepare_beets_meta_helpers

    local start_time=$(date +%s)
    local start_timestamp=$(date -u '+%Y-%m-%d %H:%M:%S')
    local queue_file="$TEMP_DIR/work_queue"
    get_tracks_from_db > "$queue_file"
    local total_work=$(wc -l < "$queue_file")

    log "Starting parallel processing of $total_work tracks..."
    [[ "$VERBOSE" == "true" ]] && log "Verbose mode: detailed progress and counters enabled"

    # Start progress monitor
    progress_monitor "$start_time" "$start_timestamp" &
    local monitor_pid=$!

    # Process in CHUNK_SIZE-track chunks
    local chunk_start=1 lines_per_job=$CHUNK_SIZE
    while [[ $chunk_start -le $total_work ]]; do
        local worker_pids=()
        for ((i=0; i<PARALLEL_JOBS && chunk_start <= total_work; i++)); do
            local end_line=$((chunk_start + lines_per_job - 1))
            [[ $end_line -gt $total_work ]] && end_line=$total_work

            local worker_queue="$TEMP_DIR/queue_${chunk_start}_${end_line}"
            sed -n "${chunk_start},${end_line}p" "$queue_file" > "$worker_queue"

            worker "$i" "$worker_queue" &
            worker_pids+=($!)
            chunk_start=$((end_line + 1))
        done

        # Wait for round to complete
        for pid in "${worker_pids[@]}"; do
            wait "$pid"
        done
    done

    # Cleanup and final stats
    kill $monitor_pid 2>/dev/null || true
    wait $monitor_pid 2>/dev/null || true

    local end_time=$(date +%s)
    local total_seconds=$((end_time - start_time))

    log "=== MINIMAL INGESTION COMPLETE ==="
    log "Runtime: $((total_seconds / 60))m $((total_seconds % 60))s"

    if [[ "$VERBOSE" == "true" ]]; then
        # Detailed stats from file counters (real-time tracked)
        local total=$(cat "$TOTAL_FILE" 2>/dev/null || echo "0")
        local success=$(cat "$SUCCESS_FILE" 2>/dev/null || echo "0")
        local failed=$(cat "$FAILED_FILE" 2>/dev/null || echo "0")
        local skipped=$(cat "$SKIPPED_FILE" 2>/dev/null || echo "0")
        log "Processed: $total, New: $success, Skipped: $skipped, Failed: $failed"
        [[ $total -gt 0 && $total_seconds -gt 0 ]] && log "Performance: $((total * 3600 / total_seconds)) tracks/hour"
    else
        # Derive detailed stats from database and work queue
        local db_new=$(sqlite3 "$RESULTS_DB" "SELECT COUNT(*) FROM tracks WHERE datetime(processed_at) >= datetime('$start_timestamp')" 2>/dev/null || echo "0")
        local work_queue_size=$(wc -l < "$queue_file" 2>/dev/null || echo "0")
        local total=$work_queue_size

        # Pre-calculate skipped by checking how many tracks from our queue were already in DB
        log "Calculating final statistics..."
        local skipped=0
        while IFS='|' read -r db_id artist title album year path; do
            [[ -n "$path" ]] || continue
            local identifier=$(echo -n "$path" | md5)
            if sqlite3 "$RESULTS_DB" "SELECT 1 FROM tracks WHERE identifier='$identifier'" 2>/dev/null | grep -q 1; then
                skipped=$((skipped + 1))
            fi
        done < "$queue_file"

        local calculated_failed=$((work_queue_size - db_new - skipped))
        [[ $calculated_failed -lt 0 ]] && calculated_failed=0

        # Cross-check by counting FAILED messages in log from this run
        local log_failed=0
        if [[ -f "$LOG_FILE" ]]; then
            # Count FAILED messages that occurred after our start time
            # Use a more reliable approach by counting lines with our timestamp pattern
            log_failed=$(awk -v start_time="$start_timestamp" '
                $0 ~ /FAILED/ && $1 " " $2 >= "[" start_time "]" { count++ }
                END { print count + 0 }
            ' "$LOG_FILE" 2>/dev/null || echo "0")
        fi

        # Report both counts
        if [[ $log_failed -eq $calculated_failed ]]; then
            log "Processed: $total, New: $db_new, Skipped: $skipped, Failed: $calculated_failed"
        else
            log "Processed: $total, New: $db_new, Skipped: $skipped, Failed: $calculated_failed (log shows $log_failed failures)"
        fi
        [[ $total -gt 0 && $total_seconds -gt 0 ]] && log "Performance: $((total * 3600 / total_seconds)) tracks/hour"
    fi

    rm -rf "$TEMP_DIR"
}

trap 'log "Interrupted"; pkill -P $$; rm -rf "$TEMP_DIR"; exit 130' INT TERM

main "$@"
