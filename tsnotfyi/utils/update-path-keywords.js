#!/usr/bin/env node
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = "/Users/tsnotfyi/project/dev/manual.db";
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => {
  if (err) {
    console.error('❌ Failed to open database:', err.message);
    process.exit(1);
  }
  console.log(`📊 Updating path keywords in ${dbPath}`);
});

function computeKeywords(decodedPath) {
  if (!decodedPath) return '';
  const segments = decodedPath.split('/').filter(Boolean);
  if (segments.length <= 5) {
    return decodedPath.toLowerCase();
  }
  const trimmed = segments.slice(5).join(' ');
  return trimmed
    .replace(/\.[^\.\s\/]+$/g, '')
    .replace(/[\/_\-\.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

db.serialize(() => {
  db.run('ALTER TABLE tracks ADD COLUMN path_keywords TEXT', (err) => {
    if (err && !/duplicate column name/i.test(err.message)) {
      console.error('❌ Failed to add path_keywords column:', err.message);
      process.exit(1);
    }
    if (!err) {
      console.log('🆕 Added path_keywords column');
    }
  });

  db.all('SELECT rowid, path_b64 FROM tracks', (err, rows) => {
    if (err) {
      console.error('❌ Failed to fetch tracks:', err.message);
      process.exit(1);
    }

    const updateStmt = db.prepare('UPDATE tracks SET path_keywords = ? WHERE rowid = ?');
    rows.forEach((row, index) => {
      try {
        const decodedPath = Buffer.from(row.path_b64, 'base64').toString('utf8');
        const keywords = computeKeywords(decodedPath);
        updateStmt.run(keywords, row.rowid);
        if ((index + 1) % 1000 === 0) {
          console.log(`🔄 Updated ${index + 1} tracks`);
        }
      } catch (e) {
        console.warn('⚠️ Failed to process row', row.rowid, e.message);
      }
    });

    updateStmt.finalize((finalizeErr) => {
      if (finalizeErr) {
        console.error('❌ Failed to finalize update:', finalizeErr.message);
      } else {
        console.log('✅ path_keywords update complete');
      }
      db.close();
    });
  });
});
