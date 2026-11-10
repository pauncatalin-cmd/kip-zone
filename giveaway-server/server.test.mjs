import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGiveawayServer } from './server.mjs';
import { createStore } from './store.mjs';

test('shared round accepts authenticated messages, deduplicates and persists the server draw', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kip-giveaway-'));
  const db = join(dir, 'state.sqlite');
  const store = createStore(db);
  const adminSecret = 'test-admin-secret';
  const tiktokSecret = 'test-relay-secret';
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let keyRequests = 0;
  const server = createGiveawayServer({ adminSecret, tiktokSecret, tiktokChannelId: 'tt-kip', kickChannelId: '87',
    siteOrigin: 'https://kipzone.example' }, store, async url => {
    assert.equal(url, 'https://api.kick.com/public/v1/public-key');
    keyRequests += 1;
    return Response.json({ data: { public_key: publicKey.export({ type: 'spki', format: 'pem' }) } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    store.close();
    rmSync(dir, { recursive: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = (path, init) => fetch(`${base}/giveaway-api/${path}`, init);
  const post = (path, secret, body) => api(path, { method: 'POST', headers: {
    Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json'
  }, body: JSON.stringify(body) });
  const state = async (query = '') => (await api(`state${query}`)).json();
  const control = (action, revision, keyword, secret = adminSecret) => post('control', secret, { action, revision, keyword });

  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/shop/`)).status, 200);
  assert.equal((await api('control', { method: 'OPTIONS', headers: { Origin: 'https://kipzone.example' } })).status, 204);
  assert.equal((await api('state', { headers: { Origin: 'https://other.example' } })).headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await control('start', 0, '!kip', 'wrong')).status, 401);
  assert.equal((await control('start', 0, '!kip', tiktokSecret)).status, 401);
  assert.equal((await control('start', 0, 'two words')).status, 400);
  const opened = await (await control('start', 0, ' !KIP ')).json();
  assert.equal(opened.keyword, '!kip');
  assert.equal((await control('reset', 0)).status, 409);

  const relay = (overrides = {}, secret = tiktokSecret) => post('tiktok', secret, { channelId: 'tt-kip', accountId: '11',
    displayName: 'Alex', text: ' !KIP ', sentAt: new Date().toISOString(), ...overrides });
  assert.equal((await relay({}, adminSecret)).status, 401);
  assert.equal((await relay({ channelId: 'other' })).status, 403);
  assert.equal((await (await relay({ sentAt: new Date(opened.serverTime - 1000).toISOString() })).json()).added, 0);
  assert.equal((await (await relay({ text: 'asta e !kip' })).json()).added, 0);
  assert.equal((await (await relay()).json()).added, 1);
  assert.equal((await (await relay({ displayName: 'Alex nou' })).json()).added, 0);

  function kick(broadcaster, alter = false) {
    const sentAt = new Date().toISOString();
    const raw = JSON.stringify({ broadcaster: { user_id: broadcaster }, sender: { user_id: 11, username: 'Alex' },
      content: '!kip', created_at: sentAt });
    const signature = sign('RSA-SHA256', Buffer.from(`test-event.${sentAt}.${raw}`), privateKey).toString('base64');
    return api('kick', { method: 'POST', body: raw + (alter ? ' ' : ''), headers: {
      'Content-Type': 'application/json', 'Kick-Event-Type': 'chat.message.sent', 'Kick-Event-Version': '1',
      'Kick-Event-Signature': signature, 'Kick-Event-Message-Id': 'test-event', 'Kick-Event-Message-Timestamp': sentAt
    } });
  }
  assert.equal((await kick(87, true)).status, 401);
  assert.equal((await kick(88)).status, 204);
  assert.equal((await kick(87)).status, 204);
  assert.equal((await kick(87)).status, 204);
  assert.equal(keyRequests, 1);

  assert.deepEqual((await state()).participants, [{ name: 'Alex', platform: 'tiktok' }, { name: 'Alex', platform: 'kick' }]);
  assert.equal((await state('?known=1:2')).participants, undefined);
  const requests = await Promise.all([control('draw', 1), control('draw', 1)]);
  assert.deepEqual(requests.map(response => response.status).sort(), [200, 409]);
  const drawing = await state('?view=obs');
  assert.equal(drawing.phase, 'drawing');
  assert.equal(drawing.participants, undefined);
  assert.equal(drawing.draw.winner, undefined);
  assert.equal(drawing.draw.reel[2], null);
  assert.equal((await (await relay({ accountId: '12' })).json()).added, 0);
  assert.equal((await control('redraw', drawing.revision)).status, 409);

  const reopened = createStore(db);
  try {
    const result = reopened.snapshot(true, drawing.draw.endsAt);
    assert.equal(result.phase, 'drawn');
    assert.equal(result.draw.winner.name, 'Alex');
    const secondDraw = reopened.control({ action: 'redraw', revision: drawing.revision }, drawing.draw.endsAt + 1);
    const secondResult = reopened.snapshot(false, secondDraw.draw.endsAt);
    assert.notEqual(secondResult.draw.winner.platform, result.draw.winner.platform);
    assert.equal(secondResult.remaining, 0);
    assert.throws(() => reopened.control({ action: 'redraw', revision: secondResult.revision }, secondDraw.draw.endsAt), /eligibili/);
    assert.equal(reopened.control({ action: 'reset', revision: secondResult.revision }, secondDraw.draw.endsAt).count, 0);
  } finally { reopened.close(); }
});

test('YouTube uses OAuth, source channel, continuation and polling interval', async t => {
  const store = createStore(':memory:');
  store.control({ action: 'start', keyword: '!kip', revision: 0 });
  const requests = [];
  const youtube = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh',
    videoId: 'video', channelId: 'UC-kip', pollMs: 5 };
  const server = createGiveawayServer({ youtube }, store, async (url, options) => {
    if (String(url).endsWith('/token')) {
      assert.equal(options.body.get('refresh_token'), 'refresh');
      return Response.json({ access_token: 'access', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer access');
    if (url.pathname.endsWith('/videos')) return Response.json({ items: [{ snippet: { channelId: 'UC-kip' },
      liveStreamingDetails: { activeLiveChatId: 'chat' } }] });
    assert.equal(url.searchParams.get('liveChatId'), 'chat');
    requests.push({ timestamp: Date.now(), token: url.searchParams.get('pageToken') });
    if (requests.length === 2) return Response.json({ error: { errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
    return Response.json({ pollingIntervalMillis: 75, nextPageToken: 'next', items: [{
      snippet: { type: 'textMessageEvent', textMessageDetails: { messageText: '!kip' }, publishedAt: new Date().toISOString() },
      authorDetails: { channelId: 'UC-participant', displayName: 'Mara' }
    }] });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.close(); await once(server, 'close'); store.close(); });
  for (let i = 0; i < 40 && requests.length < 2; i++) await sleep(10);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].token, null);
  assert.equal(requests[1].token, 'next');
  assert.ok(requests[1].timestamp - requests[0].timestamp >= 70);
  const state = await (await fetch(`http://127.0.0.1:${server.address().port}/giveaway-api/state`)).json();
  assert.deepEqual(state.participants, [{ name: 'Mara', platform: 'youtube' }]);
  assert.equal(state.sources.youtube.status, 'quota');
});
