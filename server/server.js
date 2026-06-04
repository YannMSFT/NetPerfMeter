const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { detectEnvironment, buildEnvironmentView } = require('./environment');

const PORT = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
const HOST = '0.0.0.0';
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const DEFAULT_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const randomChunk = crypto.randomBytes(CHUNK_SIZE);

const rootDir = path.resolve(__dirname, '..');
const publicDir = path.resolve(rootDir, 'public');
const packageJson = require(path.join(rootDir, 'package.json'));

// Detect cached server facts once at startup (Azure region / manual label / hostname).
// LAN-vs-Internet exposure is decided per request from the client's address.
// detectEnvironment never rejects, so awaiting the promise is always safe.
const environmentPromise = detectEnvironment();
let environmentInfo = null;
environmentPromise.then((info) => {
  environmentInfo = info;
}).catch(() => {
  environmentInfo = { isAzure: false, azureLocation: null, manualLabel: null, hostname: '' };
});

async function getEnvironment() {
  if (!environmentInfo) {
    environmentInfo = await environmentPromise;
  }
  return environmentInfo;
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.map', 'application/json; charset=utf-8'],
]);

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(req, res, statusCode, body, extraHeaders = {}) {
  if (isApiRequest(req)) {
    setCorsHeaders(res);
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function isApiRequest(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

function safePublicPath(urlPathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const resolvedPath = path.resolve(publicDir, relativePath);
  const relativeFromPublic = path.relative(publicDir, resolvedPath);

  if (relativeFromPublic.startsWith('..') || path.isAbsolute(relativeFromPublic)) {
    return null;
  }

  return resolvedPath;
}

async function serveStatic(req, res, url) {
  const filePath = safePublicPath(url.pathname);
  if (!filePath) {
    sendText(res, 404, 'Not found');
    return;
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (!stat.isFile()) {
    sendText(res, 404, 'Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': contentTypes.get(ext) || 'application/octet-stream',
    'Content-Length': stat.size,
  });
  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) {
        sendText(res, 500, 'Internal server error');
      } else {
        res.destroy();
      }
    })
    .pipe(res);
}

function parseDownloadBytes(value) {
  if (value == null) {
    return DEFAULT_DOWNLOAD_BYTES;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DOWNLOAD_BYTES;
  }

  return Math.min(Math.floor(parsed), MAX_DOWNLOAD_BYTES);
}

function waitForDrainOrClose(res) {
  return new Promise((resolve) => {
    const cleanup = () => {
      res.off('drain', onDone);
      res.off('close', onDone);
      res.off('error', onDone);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };

    res.once('drain', onDone);
    res.once('close', onDone);
    res.once('error', onDone);
  });
}

async function handleDownload(req, res, url) {
  const bytes = parseDownloadBytes(url.searchParams.get('bytes'));
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  setCorsHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Length': bytes,
  });

  let remaining = bytes;
  while (remaining > 0 && !closed) {
    const size = Math.min(remaining, CHUNK_SIZE);
    const buffer = size === CHUNK_SIZE ? randomChunk : randomChunk.subarray(0, size);
    remaining -= size;

    if (!res.write(buffer) && !closed) {
      await waitForDrainOrClose(res);
    }
  }

  if (!closed) {
    res.end();
  }
}

async function handleUpload(req, res) {
  let received = 0;

  const aborted = await new Promise((resolve) => {
    req.on('data', (chunk) => {
      received += chunk.length;
    });
    req.on('end', () => resolve(false));
    req.on('error', () => resolve(true));
    req.on('aborted', () => resolve(true));
  });

  // The client aborts outstanding uploads when its measurement window ends; that
  // is expected, so finish quietly instead of treating it as a server error.
  if (aborted || res.writableEnded || !res.writable) {
    return;
  }

  sendJson(req, res, 200, { received }, { 'Cache-Control': 'no-store' });
}

async function routeRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    const env = await getEnvironment();
    const view = buildEnvironmentView(env, req.socket && req.socket.remoteAddress);
    sendJson(req, res, 200, {
      version: packageJson.version,
      serverTime: Date.now(),
      platform: os.platform(),
      arch: os.arch(),
      hostname: view.hostname,
      exposure: view.exposure,
      location: view.location,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ping') {
    sendJson(req, res, 200, { t: Date.now() }, { 'Cache-Control': 'no-store' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/download') {
    await handleDownload(req, res, url);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/upload') {
    await handleUpload(req, res);
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(req, res, 404, { error: 'Not found' });
    return;
  }

  if (req.method === 'GET') {
    await serveStatic(req, res, url);
    return;
  }

  sendText(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  routeRequest(req, res).catch((error) => {
    console.error('Request handling failed:', error);
    if (!res.headersSent) {
      if (isApiRequest(req)) {
        sendJson(req, res, 500, { error: 'Internal server error' });
      } else {
        sendText(res, 500, 'Internal server error');
      }
    } else {
      res.destroy();
    }
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (message && message.type === 'ping') {
      ws.send(JSON.stringify({
        type: 'pong',
        seq: message.seq,
        clientTime: message.clientTime,
        serverTime: Date.now(),
      }));
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }

  return addresses;
}

server.on('error', (error) => {
  console.error('Server error:', error);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`WiFi Performance Meter listening on http://localhost:${PORT}`);
  for (const address of getLanAddresses()) {
    console.log(`LAN: http://${address}:${PORT}`);
  }
  getEnvironment().then((env) => {
    if (env.isAzure) {
      const where = env.azureLocation && env.azureLocation.displayName ? env.azureLocation.displayName : 'Azure';
      console.log(`Environment: Azure · ${where}`);
    } else if (env.manualLabel) {
      console.log(`Environment: ${env.manualLabel} (LAN/Internet determined per client)`);
    } else {
      console.log('Environment: non-Azure (LAN vs Internet determined per client connection)');
    }
  });
});
