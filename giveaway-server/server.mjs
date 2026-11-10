import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HttpError } from './store.mjs';
import { createKickReader, startYouTubeReader } from './providers.mjs';

const root = new URL('../', import.meta.url);
const contentTypes = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png' };
const staticPath = /^(?:index\.html|shop\.html|shop\/index\.html|style\.css|app\.js|logokip\.png|sapca-[1-5]\.png\.png|assets\/[\w-]+\.(?:png|svg)|giveaway\/(?:client\.js|config\.js|styles\.css|overlay\.html))$/;

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function authenticate(request, secret) {
  if (!secret) throw new HttpError(503, 'Accesul nu este configurat pe server.');
  if (!timingSafeEqual(digest(request.headers.authorization ?? ''), digest(`Bearer ${secret}`))) {
    throw new HttpError(401, 'Cheie de acces incorectă.');
  }
}

async function readBody(request, limit) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Trimite un corp JSON.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limit) throw new HttpError(413, 'Mesajul este prea mare.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function object(raw) {
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* send the same error for malformed JSON */ }
  throw new HttpError(400, 'Trimite un obiect JSON valid.');
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

export function createGiveawayServer(config, store, fetcher = fetch) {
  const kick = config.kickChannelId && createKickReader(config.kickChannelId, fetcher);
  const sources = {
    tiktok: { status: config.tiktokChannelId && config.tiktokSecret ? 'waiting' : 'disabled' },
    kick: { status: kick ? 'waiting' : 'disabled' },
    youtube: { status: config.youtube ? 'waiting' : 'disabled' }
  };
  function report(platform, status) {
    if (status === 'receiving') sources[platform].lastSeenAt = Date.now();
    sources[platform].status = status;
  }
  const stopYouTube = config.youtube && startYouTubeReader(config.youtube, store, status => report('youtube', status), fetcher);

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      if (path.startsWith('/giveaway-api/')) {
        const origin = request.headers.origin;
        if (origin && origin === config.siteOrigin) {
          response.setHeader('Access-Control-Allow-Origin', origin);
          response.setHeader('Vary', 'Origin');
          response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
          response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        }
        if (request.method === 'OPTIONS' && origin && origin === config.siteOrigin) return send(response, 204);
        if (request.method === 'GET' && path === '/giveaway-api/state') {
          const overlay = url.searchParams.get('view') === 'obs';
          return send(response, 200, { ...store.snapshot(overlay, Date.now(), url.searchParams.get('known')), sources: overlay ? undefined : sources });
        }
        if (request.method === 'POST' && path === '/giveaway-api/control') {
          authenticate(request, config.adminSecret);
          const control = object(await readBody(request, 4096));
          const state = control.action === 'check' ? store.snapshot() : store.control(control);
          return send(response, 200, { ...state, sources });
        }
        if (request.method === 'POST' && path === '/giveaway-api/kick' && kick) {
          const message = await kick(request.headers, await readBody(request, 64 * 1024));
          if (message) {
            store.ingest('kick', [message]);
            report('kick', 'receiving');
          }
          return send(response, 204);
        }
        if (request.method === 'POST' && path === '/giveaway-api/tiktok' && config.tiktokChannelId) {
          authenticate(request, config.tiktokSecret);
          const event = object(await readBody(request, 16 * 1024));
          if (event.channelId !== config.tiktokChannelId) throw new HttpError(403, 'Canal TikTok neconfigurat.');
          const { accountId, displayName, text, sentAt } = event;
          const timestamp = typeof sentAt === 'string' ? Date.parse(sentAt) : NaN;
          if (typeof accountId !== 'string' || !accountId.trim() || accountId.length > 200 || typeof displayName !== 'string' ||
              !displayName.trim() || typeof text !== 'string' || !Number.isFinite(timestamp)) {
            throw new HttpError(400, 'Eveniment TikTok invalid.');
          }
          const added = store.ingest('tiktok', [{ account: accountId, name: displayName, text, sentAt: timestamp }]);
          report('tiktok', 'receiving');
          return send(response, 200, { added });
        }
        throw new HttpError(404, 'Adresă indisponibilă.');
      }
      const file = { '/': 'index.html', '/shop': 'shop/index.html', '/shop/': 'shop/index.html' }[path] ?? path.slice(1);
      if (!['GET', 'HEAD'].includes(request.method) || !staticPath.test(file)) throw new HttpError(404, 'Pagină indisponibilă.');
      const data = await readFile(new URL(file, root));
      response.writeHead(200, { 'Content-Type': contentTypes[file.split('.').at(-1)], 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Giveaway request:', error.code ?? error.name);
      if (!response.headersSent) {
        if (error.status === 413) response.setHeader('Connection', 'close');
        send(response, error.status ?? 500, { error: error instanceof HttpError ? error.message : 'Eroare internă.' });
      }
    }
  });
  server.on('close', () => stopYouTube?.());
  return server;
}

function readConfig(env) {
  const { GIVEAWAY_ADMIN_TOKEN: adminSecret, TIKTOK_RELAY_TOKEN: tiktokSecret, TIKTOK_CHANNEL_ID: tiktokChannelId,
    KICK_BROADCASTER_ID: kickChannelId, GIVEAWAY_SITE_ORIGIN: siteOrigin } = env;
  for (const secret of [adminSecret, tiktokSecret]) {
    if (secret && !/^\S{32,}$/.test(secret)) throw new Error('Cheile Giveaway trebuie să aibă cel puțin 32 de caractere fără spații.');
  }
  if (adminSecret && adminSecret === tiktokSecret) throw new Error('Folosește chei distincte pentru administrare și TikTok.');
  if (Boolean(tiktokSecret) !== Boolean(tiktokChannelId)) throw new Error('Configurează împreună TIKTOK_RELAY_TOKEN și TIKTOK_CHANNEL_ID.');
  if (kickChannelId && !/^[1-9]\d*$/.test(kickChannelId)) throw new Error('KICK_BROADCASTER_ID trebuie să fie ID-ul numeric al canalului.');
  if (siteOrigin && (new URL(siteOrigin).origin !== siteOrigin || !/^https?:\/\//.test(siteOrigin))) {
    throw new Error('GIVEAWAY_SITE_ORIGIN trebuie să fie o origine exactă, fără cale sau slash la final.');
  }
  const youtube = { videoId: env.YOUTUBE_VIDEO_ID, channelId: env.YOUTUBE_CHANNEL_ID, clientId: env.YOUTUBE_CLIENT_ID,
    clientSecret: env.YOUTUBE_CLIENT_SECRET, refreshToken: env.YOUTUBE_REFRESH_TOKEN };
  const values = Object.values(youtube);
  if (values.some(Boolean) && !values.every(Boolean)) throw new Error('Completează toate cele cinci variabile de conectare YouTube.');
  const pollMs = Number(env.YOUTUBE_POLL_MS ?? '10000');
  if (!Number.isSafeInteger(pollMs) || pollMs < 5000 || pollMs > 300_000) throw new Error('YOUTUBE_POLL_MS trebuie să fie între 5000 și 300000.');
  return { adminSecret, tiktokSecret, tiktokChannelId, kickChannelId, siteOrigin,
    youtube: youtube.videoId ? { ...youtube, pollMs } : null };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = readConfig(process.env);
  const database = resolve(process.env.GIVEAWAY_DB ?? fileURLToPath(new URL('.giveaway-data/state.sqlite', root)));
  await mkdir(dirname(database), { recursive: true });
  const store = createStore(database);
  const server = createGiveawayServer(config, store);
  server.on('close', () => store.close());
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || '3000');
  server.listen(port, host, () => console.log(`KIP Giveaway · http://${host}:${server.address().port}`));
}
