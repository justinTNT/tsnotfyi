#!/usr/bin/env python3
import argparse
import base64
import os
import sqlite3
from pathlib import Path


def compute_keywords(decoded_path: str) -> str:
    if not decoded_path:
        return ""
    parts = [p for p in decoded_path.split('/') if p]
    if len(parts) <= 5:
        return decoded_path.lower()
    trimmed = ' '.join(parts[5:])
    trimmed = trimmed.split('.')[0] if '.' in parts[-1] else trimmed
    return (
        trimmed
        .replace('_', ' ')
        .replace('-', ' ')
        .replace('.', ' ')
        .replace('/', ' ')
        .strip()
        .lower()
    )


def main():
    parser = argparse.ArgumentParser(description="Populate path_keywords by decoding path_b64")
    parser.add_argument(
        '--db',
        default=os.path.join(Path(__file__).resolve().parent.parent, 'results.db'),
        help='Path to results.db (defaults to project results.db)'
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"❌ Database not found: {db_path}")
        return 1

    conn = sqlite3.connect(db_path)
    conn.execute('PRAGMA journal_mode=WAL;')
    conn.execute('PRAGMA synchronous=NORMAL;')

    print(f"📊 Updating path_keywords in {db_path}")

    try:
        conn.execute('ALTER TABLE tracks ADD COLUMN path_keywords TEXT;')
        print('🆕 Added path_keywords column')
    except sqlite3.OperationalError as exc:
        if 'duplicate column name' in str(exc).lower():
            print('ℹ️ path_keywords column already exists')
        else:
            raise

    rows = conn.execute('SELECT rowid, path_b64 FROM tracks').fetchall()
    total = len(rows)

    with conn:
        for idx, (rowid, path_b64) in enumerate(rows, start=1):
            try:
                decoded = base64.b64decode(path_b64).decode('utf-8')
                keywords = compute_keywords(decoded)
                conn.execute('UPDATE tracks SET path_keywords = ? WHERE rowid = ?', (keywords, rowid))
            except Exception as exc:
                print(f"⚠️ Failed to process rowid={rowid}: {exc}")
            if idx % 1000 == 0:
                print(f"   🔄 updated {idx}/{total}")

    print('✅ path_keywords update complete')
    conn.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
