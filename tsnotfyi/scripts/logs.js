#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const LOG_ROOT = path.join(__dirname, '..', 'logs');

function getLatestLogFile(type) {
  const dir = path.join(LOG_ROOT, type);
  if (!fs.existsSync(dir)) {
    throw new Error(`Log directory missing: ${dir}`);
  }
  const files = fs.readdirSync(dir).filter(name => name.endsWith('.log')).sort();
  if (!files.length) {
    throw new Error(`No log files in ${dir}`);
  }
  return path.join(dir, files[files.length - 1]);
}

function tailLogs(type) {
  const file = getLatestLogFile(type);
  console.log(`[logs] tailing ${file}`);
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  stream.pipe(process.stdout);
  stream.on('end', () => {
    console.log(`\n[logs] hit EOF on ${file}; run again to continue.`);
  });
}

function grepLogs(type, key, value) {
  const file = getLatestLogFile(type);
  const content = fs.readFileSync(file, 'utf8');
  content.split('\n').forEach(line => {
    if (!line.trim()) return;
    try {
      const entry = JSON.parse(line);
      if (entry[key] && String(entry[key]).includes(value)) {
        console.log(line);
      }
    } catch (_) {
      if (line.includes(value)) {
        console.log(line);
      }
    }
  });
}

function main() {
  const [command, type = 'server', key = 'sessionId', value = ''] = process.argv.slice(2);
  if (!command || !['tail', 'grep'].includes(command)) {
    console.error('Usage: node scripts/logs.js <tail|grep> [server|client] [field] [value]');
    process.exit(1);
  }
  if (command === 'tail') {
    tailLogs(type);
    return;
  }
  const filterValue = value || process.env.LOG_FILTER || '';
  if (!filterValue) {
    console.error('grep requires a value (argument or LOG_FILTER env var)');
    process.exit(1);
  }
  grepLogs(type, key, filterValue);
}

main();
