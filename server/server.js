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
const MAX_UPLOAD_BYTES = parsePositiveIntegerEnv('MAX_UPLOAD_BYTES', 16 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = parsePositiveIntegerEnv('REQUEST_TIMEOUT_MS', 120_000);
const HEADERS_TIMEOUT_MS = parsePositiveIntegerEnv('HEADERS_TIMEOUT_MS', 10_000);
const UPLOAD_TIMEOUT_MS = parsePositiveIntegerEnv('UPLOAD_TIMEOUT_MS', 60_000);
const DOWNLOAD_TIMEOUT_MS = parsePositiveIntegerEnv('DOWNLOAD_TIMEOUT_MS', 120_000);
const MAX_ACTIVE_TRANSFERS_PER_IP = parsePositiveIntegerEnv('MAX_ACTIVE_TRANSFERS_PER_IP', 8);
const WS_MAX_PAYLOAD_BYTES = parsePositiveIntegerEnv('WS_MAX_PAYLOAD_BYTES', 1024);
const WS_RATE_WINDOW_MS = parsePositiveIntegerEnv('WS_RATE_WINDOW_MS', 10_000);
const WS_MAX_MESSAGES_PER_WINDOW = parsePositiveIntegerEnv('WS_MAX_MESSAGES_PER_WINDOW', 120);
const EXPOSE_SERVER_DETAILS = process.env.EXPOSE_SERVER_DETAILS === 'true';
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const randomChunk = crypto.randomBytes(CHUNK_SIZE);
const activeTransfersByAddress = new Map();

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

function parsePositiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseAllowedOrigins(value) {
  if (!value) {
    return new Set();
  }
  return new Set(String(value).split(',').map((origin) => origin.trim()).filter(Boolean));
}

function requestProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') {
    return forwarded;
  }
  return req.socket && req.socket.encrypted ? 'https' : 'http';
}

function requestHost(req) {
  return String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
}

function isSameOrigin(req, origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  return parsed.host.toLowerCase() === requestHost(req) && parsed.protocol === `${requestProtocol(req)}:`;
}

function allowedRequestOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return null;
  }

  const value = String(origin);
  if (isSameOrigin(req, value) || ALLOWED_ORIGINS.has(value)) {
    return value;
  }

  return false;
}

function isAllowedBrowserRequest(req) {
  const origin = allowedRequestOrigin(req);
  if (origin === false) {
    return false;
  }

  // Blocks no-cors cross-site fetches/images that do not include an Origin header.
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return fetchSite !== 'cross-site';
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=(), usb=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
  );
}

function setCorsHeaders(req, res) {
  const origin = allowedRequestOrigin(req);
  if (!origin) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function sendText(res, statusCode, body) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendJson(req, res, statusCode, body, extraHeaders = {}) {
  setSecurityHeaders(res);
  if (isApiRequest(req)) {
    setCorsHeaders(req, res);
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

function remoteAddressKey(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function acquireTransferSlot(req, res) {
  const key = remoteAddressKey(req);
  const current = activeTransfersByAddress.get(key) || 0;
  if (current >= MAX_ACTIVE_TRANSFERS_PER_IP) {
    sendJson(req, res, 429, { error: 'Too many active transfers' }, { 'Retry-After': '5' });
    return null;
  }

  activeTransfersByAddress.set(key, current + 1);
  return () => {
    const next = (activeTransfersByAddress.get(key) || 1) - 1;
    if (next > 0) {
      activeTransfersByAddress.set(key, next);
    } else {
      activeTransfersByAddress.delete(key);
    }
  };
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
  setSecurityHeaders(res);
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
  const releaseSlot = acquireTransferSlot(req, res);
  if (!releaseSlot) {
    return;
  }

  const bytes = parseDownloadBytes(url.searchParams.get('bytes'));
  let closed = false;
  const timeout = setTimeout(() => {
    closed = true;
    res.destroy();
  }, DOWNLOAD_TIMEOUT_MS);
  res.on('close', () => {
    closed = true;
  });

  try {
    setSecurityHeaders(res);
    setCorsHeaders(req, res);
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
  } finally {
    clearTimeout(timeout);
    releaseSlot();
  }
}

async function handleUpload(req, res) {
  const releaseSlot = acquireTransferSlot(req, res);
  if (!releaseSlot) {
    return;
  }

  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_BYTES) {
    releaseSlot();
    sendJson(req, res, 413, { error: 'Upload too large' });
    req.destroy();
    return;
  }

  let received = 0;
  let tooLarge = false;
  const timeout = setTimeout(() => {
    req.destroy(new Error('Upload timed out'));
  }, UPLOAD_TIMEOUT_MS);

  try {
    const aborted = await new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      req.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_UPLOAD_BYTES) {
          tooLarge = true;
          done(false);
          req.destroy();
        }
      });
      req.on('end', () => done(false));
      req.on('error', () => done(true));
      req.on('aborted', () => done(true));
    });

    if (tooLarge) {
      if (!res.writableEnded && res.writable) {
        sendJson(req, res, 413, { error: 'Upload too large' });
      }
      return;
    }

    // The client aborts outstanding uploads when its measurement window ends; that
    // is expected, so finish quietly instead of treating it as a server error.
    if (aborted || res.writableEnded || !res.writable) {
      return;
    }

    sendJson(req, res, 200, { received }, { 'Cache-Control': 'no-store' });
  } finally {
    clearTimeout(timeout);
    releaseSlot();
  }
}

async function routeRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/api/')) {
    if (!isAllowedBrowserRequest(req)) {
      sendJson(req, res, 403, { error: 'Forbidden' });
      return;
    }

    if (req.method === 'OPTIONS') {
      setSecurityHeaders(res);
      setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/info') {
    const env = await getEnvironment();
    const view = buildEnvironmentView(env, req.socket && req.socket.remoteAddress);
    sendJson(req, res, 200, {
      version: EXPOSE_SERVER_DETAILS ? packageJson.version : '',
      serverTime: Date.now(),
      platform: EXPOSE_SERVER_DETAILS ? os.platform() : '',
      arch: EXPOSE_SERVER_DETAILS ? os.arch() : '',
      hostname: EXPOSE_SERVER_DETAILS ? view.hostname : '',
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
server.requestTimeout = REQUEST_TIMEOUT_MS;
server.headersTimeout = Math.min(HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
server.keepAliveTimeout = 5_000;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD_BYTES,
  perMessageDeflate: false,
});

function isValidPingMessage(message) {
  return message &&
    message.type === 'ping' &&
    Number.isSafeInteger(message.seq) &&
    message.seq >= 0 &&
    Number.isFinite(message.clientTime);
}

function isWithinWebSocketRateLimit(ws) {
  const now = Date.now();
  if (!ws.rateWindowStart || now - ws.rateWindowStart > WS_RATE_WINDOW_MS) {
    ws.rateWindowStart = now;
    ws.rateWindowMessages = 0;
  }

  ws.rateWindowMessages += 1;
  return ws.rateWindowMessages <= WS_MAX_MESSAGES_PER_WINDOW;
}

function rejectUpgrade(socket, statusCode) {
  socket.write(`HTTP/1.1 ${statusCode} Forbidden\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    rejectUpgrade(socket, 400);
    return;
  }

  if (pathname !== '/ws') {
    rejectUpgrade(socket, 404);
    return;
  }

  if (!isAllowedBrowserRequest(req)) {
    rejectUpgrade(socket, 403);
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data) => {
    if (!isWithinWebSocketRateLimit(ws)) {
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      ws.close(1003, 'Invalid JSON');
      return;
    }

    if (!isValidPingMessage(message)) {
      ws.close(1008, 'Invalid message');
      return;
    }

    ws.send(JSON.stringify({
      type: 'pong',
      seq: message.seq,
      clientTime: message.clientTime,
      serverTime: Date.now(),
    }));
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
