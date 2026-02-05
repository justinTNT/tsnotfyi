#!/usr/bin/env node
/**
 * Filter large log files by timestamp and/or content.
 *
 * Examples:
 *   node scripts/filter-logs.js --file console.log --contains "Murcof"
 *   node scripts/filter-logs.js --file server.log --regex "trackId: '93d0ca" --since 2025-11-13T11:30:00Z
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function printUsage() {
  console.log(`Usage: node scripts/filter-logs.js --file <path> [options]

Options:
  --file <path>         Log file to read (required)
  --contains <string>   Plain substring that must be present in the line
  --regex <pattern>     Regular expression (JS syntax) that must match the line
  --since <ISO>         Only include lines with timestamps >= ISO (e.g. 2025-11-13T11:30:00Z)
  --until <ISO>         Only include lines with timestamps <= ISO
  --help                Show this message
`);
}

function parseArgs(argv) {
  const args = { file: null, contains: null, regex: null, since: null, until: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--file':
        args.file = argv[++i];
        break;
      case '--contains':
        args.contains = argv[++i];
        break;
      case '--regex':
        args.regex = argv[++i];
        break;
      case '--since':
        args.since = argv[++i];
        break;
      case '--until':
        args.until = argv[++i];
        break;
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        console.warn(`Unknown argument: ${arg}`);
        printUsage();
        process.exit(1);
    }
  }
  if (!args.file) {
    console.error('Error: --file is required.');
    printUsage();
    process.exit(1);
  }
  return args;
}

function buildFilters({ contains, regex, since, until }) {
  const filters = [];
  if (contains) {
    filters.push((line) => line.includes(contains));
  }
  if (regex) {
    const re = new RegExp(regex);
    filters.push((line) => re.test(line));
  }

  const sinceTs = since ? Date.parse(since) : null;
  const untilTs = until ? Date.parse(until) : null;

  if (Number.isNaN(sinceTs)) {
    console.error(`Invalid --since timestamp: ${since}`);
    process.exit(1);
  }
  if (Number.isNaN(untilTs)) {
    console.error(`Invalid --until timestamp: ${until}`);
    process.exit(1);
  }

  filters.push((line) => {
    if (sinceTs === null && untilTs === null) {
      return true;
    }
    const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    if (!match) {
      // keep lines without timestamps if we're inside the window already
      return sinceTs === null && untilTs === null;
    }
    const ts = Date.parse(match[1]);
    if (Number.isNaN(ts)) {
      return false;
    }
    if (sinceTs !== null && ts < sinceTs) {
      return false;
    }
    if (untilTs !== null && ts > untilTs) {
      return false;
    }
    return true;
  });

  return (line) => filters.every((fn) => fn(line));
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(process.cwd(), options.file);
  if (!fs.existsSync(filePath)) {
    console.error(`Log file not found: ${filePath}`);
    process.exit(1);
  }
  const passesFilters = buildFilters(options);
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    if (passesFilters(line)) {
      console.log(line);
    }
  });

  await new Promise((resolve) => rl.once('close', resolve));
}

run().catch((err) => {
  console.error('filter-logs failed:', err);
  process.exit(1);
});
