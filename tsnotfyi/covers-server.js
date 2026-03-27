// Covers server — serves album art from local disk
// Lightweight static file server, tunneled as covers.tsnot.fyi

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3004;

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

const server = http.createServer((req, res) => {
  // Only serve from /Volumes
  const filePath = decodeURIComponent(req.url);

  if (!filePath.startsWith('/Volumes/')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext];
  if (!mime) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`🖼️  Covers server listening on port ${PORT}`);
});
