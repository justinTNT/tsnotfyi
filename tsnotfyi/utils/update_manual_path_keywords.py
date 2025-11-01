#!/usr/bin/env python3
import argparse
import os
import sqlite3
from pathlib import Path


def compute_keywords(path_str: str) -> str:
    if not path_str:
        return ""
    segments = [seg for seg in path_str.split('/') if seg]
    if len(segments) <= 5:
        trimmed = path_str
    else:
        trimmed = ' '.join(segments[5:])
    if segments:
        filename = segments[-1]
        if '.' in filename:
            trimmed = trimmed.rsplit('.', 1)[0]
    return (
        trimmed
        .replace('_', ' ')
        .replace('-', ' ')
        .replace('.', ' ')
        .replace('/', ' ')
        .strip()
        .lower()
    )


def to_text(value):
    if value is None:
        return None
    if isinstance(value, memoryview):
        value = bytes(value)
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8')
        except UnicodeDecodeError:
            return value.hex()
    return str(value)


def main():
    default_db = '/Users/tsnotfyi/project/dev/manual.db'
    parser = argparse.ArgumentParser(description='Populate path_keywords in music_analysis table')
    parser.add_argument('--db', default=str(default_db), help='Path to manual.db (default: %(default)s)')
    args = parser.parse_args()

    db_path = Path(args.db).expanduser()
    if not db_path.exists():
        print(f"❌ Database not found: {db_path}")
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA synchronous=NORMAL;')

    print(f"📊 Updating path_keywords in {db_path}")

    try:
        conn.execute('ALTER TABLE music_analysis ADD COLUMN path_keywords TEXT;')
        print('🆕 Added path_keywords column')
    except sqlite3.OperationalError as exc:
        if 'duplicate column name' in str(exc).lower():
            print('ℹ️ path_keywords column already exists')
        else:
            raise

    rows = conn.execute('SELECT rowid, bt_path, bt_id FROM music_analysis').fetchall()
    total = len(rows)

    with conn:
        for idx, row in enumerate(rows, start=1):
            path_text = to_text(row['bt_path'])
            keywords = compute_keywords(path_text) if path_text else ''
            conn.execute(
                'UPDATE music_analysis SET path_keywords = ? WHERE rowid = ?',
                (keywords, row['rowid'])
            )
            if idx % 1000 == 0:
                print(f"   🔄 updated {idx}/{total}")

    print('✅ path_keywords update complete')
    conn.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
