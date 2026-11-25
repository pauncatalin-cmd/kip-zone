const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const draw = require("../giveaway/draw-math");
const demo = require("../giveaway/demo");
const wheel = require("../giveaway/wheel-layout");
const { createMemoryRedis, createUpstashRedis, redisFromEnv } = require("../api/_lib/redis");
const api = require("../api/_lib/giveaway");
const match = require("../tools/giveaway-collector/match");
const { extractTikTokChat } = require("../tools/giveaway-collector/tiktok");
const { extractMessages } = require("../tools/giveaway-collector/youtube");
const { postEntry } = require("../tools/giveaway-collector/post");
const { createStore } = require("../tools/giveaway-collector/store");

const INGEST = "ingest-secret-value-0123456789";
const ADMIN = "admin-secret-value-0123456789";
const OPEN = Date.parse(draw.CAMPAIGN.open);
const CLOSE = Date.parse(draw.CAMPAIGN.close);

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
}

function world(now) {
  return {
    redis: createMemoryRedis(),
    env: {
      UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "token",
      GIVEAWAY_INGEST_SECRET: INGEST,
      GIVEAWAY_ADMIN_SECRET: ADMIN,
    },
    now: () => now,
  };
}

async function call(handler, req, options) {
  const res = mockRes();
  await handler({
    method: req.method || "GET",
    headers: req.headers || {},
    body: req.body,
    query: req.query || {},
    url: req.url || "/",
  }, res, options);
  return res;
}

function auth(secret) {
  return { authorization: "Bearer " + secret };
}

function entry(over) {
  return Object.assign({
    platform: "tiktok",
    userId: "user-secret-42",
    handle: "ana",
    displayName: "Ana",
    liveId: "live-1",
    ts: "2026-12-10T12:00:00+02:00",
    messageId: "m1",
    command: "!gta6",
  }, over || {});
}

async function postEntryApi(options, body) {
  return call(api.handleEntry, { method: "POST", headers: auth(INGEST), body }, options);
}

test("campaign instants and sha256 stay fixed", async () => {
  assert.equal(OPEN, Date.UTC(2026, 10, 30, 22, 0, 0));
  assert.equal(CLOSE, Date.UTC(2026, 11, 24, 18, 0, 0));
  assert.equal(await draw.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(await draw.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await draw.uint48("seed-seed-seed-seed", "ab".repeat(32), 0), 82882069800385);
});

test("weighted tickets and the draw are deterministic", async () => {
  const pool = [{ key: "a", weight: 1 }, { key: "b", weight: 3 }];
  const counts = { a: 0, b: 0 };
  for (let ticket = 0; ticket < 4; ticket++) counts[pool[draw.indexForTicket(pool, ticket)].key] += 1;
  assert.deepEqual(counts, { a: 1, b: 3 });

  const people = [
    { key: "a", platform: "tiktok", handle: "ana", displayName: "Ana", weight: 1, dates: ["2026-12-01"] },
    { key: "b", platform: "youtube", handle: "bogdan", displayName: "Bogdan", weight: 3, dates: ["2026-12-02"] },
  ];
  const snapshotHash = await draw.sha256Hex(draw.canonicalJson(people));
  assert.equal(snapshotHash, "7b94f70f04884b1ba1682f7b52df3d8fd3d7b923633c42d921888b009c303842");
  const first = await draw.drawWinners(people, "test-seed-0123456789", snapshotHash, 5);
  const second = await draw.drawWinners(people, "test-seed-0123456789", snapshotHash, 5);
  assert.deepEqual(first, second);
  assert.deepEqual(first.picks.map((row) => row.handle), ["bogdan", "ana"]);

  for (const seed of ["alpha-seed-000000", "beta-seed-000000", "gamma-seed-000000"]) {
    const solo = await draw.drawWinners([people[1]], seed, snapshotHash, 5);
    assert.equal(solo.picks[0].handle, "bogdan");
  }
  let counter = 0;
  for (let i = 0; i < 30; i++) {
    const roll = await draw.uniformBelow("seed-seed-seed-seed", snapshotHash, 10, counter);
    counter = roll.counter;
    assert.ok(roll.value >= 0 && roll.value < 10);
  }
});

test("exact command, window, dedup and account age", async () => {
  const options = world(Date.parse("2026-12-10T18:00:00+02:00"));
  const first = await postEntryApi(options, entry());
  assert.equal(first.statusCode, 201);
  const again = await postEntryApi(options, entry({ messageId: "m-again" }));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.status, "duplicate");
  assert.equal(await options.redis.command(["LLEN", "gta6:log"]), 1);

  for (const command of ["!gta6", "  !GTA6  ", "!\u200Bgta6"]) {
    const created = await postEntryApi(options, entry({
      command,
      userId: "cmd-user",
      liveId: "cmd-" + command.length,
      messageId: "cmd-" + command.length,
    }));
    assert.equal(created.statusCode, 201, command);
  }
  for (const command of ["!gta6!", "!gta6 te rog", "gta6", ""]) {
    const rejected = await postEntryApi(options, entry({ command, liveId: "bad-" + command.length, messageId: "bad-" + command.length }));
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body.error, "command");
  }

  const secondLive = await postEntryApi(options, entry({ liveId: "live-2", messageId: "m2" }));
  assert.equal(secondLive.statusCode, 201);
  assert.equal(secondLive.body.entries, 2);
  const otherPlatform = await postEntryApi(options, entry({
    platform: "youtube",
    userId: "user-secret-42",
    handle: "ana",
    liveId: "yt-1",
    messageId: "ym",
  }));
  assert.equal(otherPlatform.statusCode, 201);
  const sameName = await postEntryApi(options, entry({
    userId: "other-secret",
    handle: "ana",
    displayName: "Ana",
    liveId: "live-9",
    messageId: "m9",
  }));
  assert.equal(sameName.statusCode, 201);

  const atOpen = world(OPEN + 1000);
  assert.equal((await postEntryApi(atOpen, entry({ ts: OPEN, liveId: "open", messageId: "o" }))).statusCode, 201);
  assert.equal((await postEntryApi(options, entry({ ts: OPEN - 1, liveId: "early", messageId: "e" }))).statusCode, 403);
  const atClose = world(CLOSE);
  assert.equal((await postEntryApi(atClose, entry({ ts: CLOSE - 1, liveId: "last", messageId: "l" }))).statusCode, 201);
  assert.equal((await postEntryApi(atClose, entry({ ts: CLOSE, liveId: "after", messageId: "a" }))).body.error, "window");

  const young = await postEntryApi(options, entry({
    liveId: "young",
    messageId: "y",
    accountCreatedAt: Date.parse("2026-12-10T12:00:00+02:00") - draw.CAMPAIGN.minAccountAgeMs + 1,
  }));
  assert.equal(young.body.error, "account_age");
  const oldEnough = await postEntryApi(options, entry({
    liveId: "old",
    messageId: "old",
    accountCreatedAt: Date.parse("2026-12-10T12:00:00+02:00") - draw.CAMPAIGN.minAccountAgeMs,
  }));
  assert.equal(oldEnough.statusCode, 201);
  const unknownAge = await postEntryApi(options, entry({ liveId: "unknown-age", messageId: "ua" }));
  assert.equal(unknownAge.statusCode, 201);

  const tooSoon = await postEntryApi(world(Date.parse("2026-11-25T12:00:00+02:00")), entry({ ts: OPEN }));
  assert.equal(tooSoon.statusCode, 400);
});

test("leaderboard hides internal ids and banned accounts", async () => {
  const options = world(Date.parse("2026-12-10T18:00:00+02:00"));
  await postEntryApi(options, entry({ userId: "UC_secret_999", handle: "zoran", displayName: "Zoran", liveId: "a", messageId: "1" }));
  await postEntryApi(options, entry({ userId: "UC_secret_999", handle: "zoran", displayName: "Zoran", liveId: "b", messageId: "2" }));
  await postEntryApi(options, entry({ userId: "id-ana", handle: "ana", displayName: "Ana Pop", liveId: "a", messageId: "3" }));
  await call(api.handleBan, {
    method: "POST",
    headers: auth(ADMIN),
    body: { platform: "tiktok", userId: "id-ana" },
  }, options);

  const board = await call(api.handleLeaderboard, { method: "GET" }, options);
  assert.equal(board.statusCode, 200);
  assert.equal(board.body.participants, 1);
  assert.equal(board.body.entries, 2);
  assert.equal(board.body.leaders.length, 1);
  assert.equal(board.body.leaders[0].handle, "zoran");
  assert.equal(board.body.leaders[0].platform, "tiktok");
  assert.equal(board.body.leaders[0].entries, 2);
  assert.equal(JSON.stringify(board.body).includes("UC_secret_999"), false);
  assert.equal(JSON.stringify(board.body).includes("id-ana"), false);
  assert.equal(Object.hasOwn(board.body.leaders[0], "userId"), false);

  const stats = await call(api.handleStats, { method: "GET" }, options);
  assert.equal(stats.body.participants, 1);
  assert.equal(stats.body.entries, 2);
  assert.equal(stats.body.open, true);

  const search = await call(api.handleSearch, { method: "GET", query: { q: "ana" } }, options);
  assert.equal(search.body.results.length, 0);
  const found = await call(api.handleSearch, { method: "GET", query: { q: "zor" } }, options);
  assert.equal(found.body.results[0].handle, "zoran");
  assert.equal(JSON.stringify(found.body).includes("UC_secret_999"), false);

  for (let i = 0; i < 20; i++) {
    await postEntryApi(options, entry({
      userId: "bulk-" + i,
      handle: "bulk" + String(i).padStart(2, "0"),
      displayName: "Bulk " + i,
      liveId: "bulk",
      messageId: "bulk-" + i,
    }));
  }
  const capped = await call(api.handleLeaderboard, { method: "GET" }, options);
  assert.equal(capped.body.leaders.length, 20);
  assert.equal(capped.body.participants, 21);
  assert.equal(capped.body.leaders[0].handle, "zoran");
});

test("missing redis is a clear error and secrets are compared", async () => {
  const stats = await call(api.handleStats, { method: "GET" }, { env: {} });
  assert.equal(stats.statusCode, 503);
  assert.equal(stats.body.configured, false);
  assert.match(stats.body.message, /UPSTASH_REDIS_REST_URL/);
  assert.match(stats.body.message, /KV_REST_API_URL/);
  assert.match(stats.body.message, /KV_REST_API_TOKEN/);
  const partial = redisFromEnv({ UPSTASH_REDIS_REST_URL: "http://example.upstash.io", UPSTASH_REDIS_REST_TOKEN: "x" });
  assert.equal(partial.ok, false);
  const fromMarketplace = redisFromEnv({
    KV_REST_API_URL: "https://example.upstash.io",
    KV_REST_API_TOKEN: "kv-token",
  });
  assert.equal(fromMarketplace.ok, true);
  const prefersUpstash = redisFromEnv({
    UPSTASH_REDIS_REST_URL: "http://insecure.example",
    UPSTASH_REDIS_REST_TOKEN: "a",
    KV_REST_API_URL: "https://example.upstash.io",
    KV_REST_API_TOKEN: "b",
  });
  assert.equal(prefersUpstash.ok, false);
  assert.match(prefersUpstash.message, /HTTPS/);

  const options = world(Date.parse("2026-12-10T18:00:00+02:00"));
  const denied = await call(api.handleEntry, { method: "POST", headers: auth("nope"), body: entry() }, options);
  assert.equal(denied.statusCode, 401);
  const adminOnEntry = await call(api.handleEntry, { method: "POST", headers: auth(ADMIN), body: entry() }, options);
  assert.equal(adminOnEntry.statusCode, 401);
  const ingestOnBan = await call(api.handleBan, {
    method: "POST",
    headers: auth(INGEST),
    body: { platform: "tiktok", userId: "x" },
  }, options);
  assert.equal(ingestOnBan.statusCode, 401);

  const broken = {
    async command() { throw Object.assign(new Error("super-token"), { code: "redis" }); },
    async pipeline() { throw Object.assign(new Error("super-token"), { code: "redis" }); },
  };
  const failed = await call(api.handleStats, { method: "GET" }, { redis: broken, env: options.env });
  assert.equal(failed.statusCode, 502);
  assert.equal(failed.body.error, "redis");
  assert.equal(String(failed.body.message).includes("super-token"), false);
});

test("commit, freeze and reveal stay deterministic and private", async () => {
  const options = world(Date.parse("2026-12-10T18:00:00+02:00"));
  const seed = "test-seed-0123456789";
  await postEntryApi(options, entry({ userId: "winner-secret", handle: "ana", liveId: "l1", messageId: "1" }));
  await postEntryApi(options, entry({ userId: "winner-secret", handle: "ana", liveId: "l2", messageId: "2" }));
  await postEntryApi(options, entry({ userId: "winner-secret", handle: "ana", liveId: "l3", messageId: "3" }));
  await postEntryApi(options, entry({
    userId: "other-secret",
    handle: "=1+1",
    displayName: "Altul",
    liveId: "l1",
    messageId: "4",
  }));

  const tooEarly = await call(api.handleDraw, {
    method: "POST",
    headers: auth(ADMIN),
    body: { action: "freeze" },
  }, options);
  assert.equal(tooEarly.body.error, "too_early");

  const committed = await call(api.handleDraw, {
    method: "POST",
    headers: auth(ADMIN),
    body: { action: "commit", seed },
  }, options);
  assert.equal(committed.statusCode, 200);
  const storedCommit = await options.redis.command(["GET", "gta6:commit"]);
  assert.equal(storedCommit.includes(seed), false);
  assert.equal(committed.body.hash, await draw.sha256Hex(seed));

  const late = world(CLOSE + 60 * 1000);
  late.redis = options.redis;
  late.env = options.env;
  const beforeFreeze = await postEntryApi(late, entry({
    userId: "late-secret",
    handle: "tarziu",
    ts: CLOSE - 1000,
    liveId: "late",
    messageId: "late",
  }));
  assert.equal(beforeFreeze.statusCode, 201);
  const frozen = await call(api.handleDraw, {
    method: "POST",
    headers: auth(ADMIN),
    body: { action: "freeze" },
  }, late);
  assert.equal(frozen.statusCode, 200);
  const after = await postEntryApi(late, entry({
    userId: "blocked-secret",
    handle: "blocat",
    ts: CLOSE - 1000,
    liveId: "blocked",
    messageId: "blocked",
  }));
  assert.equal(after.body.error, "frozen");

  const wrong = await call(api.handleDraw, {
    method: "POST",
    headers: auth(ADMIN),
    body: { action: "reveal", seed: "not-the-real-seed-value" },
  }, late);
  assert.equal(wrong.statusCode, 403);
  const revealed = await call(api.handleDraw, {
    method: "POST",
    headers: auth(ADMIN),
    body: { action: "reveal", seed },
  }, late);
  assert.equal(revealed.statusCode, 200);
  assert.equal(typeof revealed.body.result.winner.userId, "string");
  assert.equal(revealed.body.result.winner.userId.length > 0, true);

  const pub = await call(api.handleDraw, { method: "GET", url: "/api/giveaway/draw?full=1" }, late);
  for (const secret of ["winner-secret", "other-secret", "late-secret"]) {
    assert.equal(JSON.stringify(pub.body).includes(secret), false);
  }
  assert.equal(pub.body.result.seed, seed);
  const again = await draw.drawWinners(pub.body.snapshot.list, seed, pub.body.snapshot.hash, draw.CAMPAIGN.reserves);
  assert.equal(again.picks[0].key, pub.body.result.winner.key);
  assert.equal(await draw.sha256Hex(draw.canonicalJson(pub.body.snapshot.list)), pub.body.snapshot.hash);

  const adminView = await call(api.handleDraw, { method: "GET", headers: auth(ADMIN) }, late);
  assert.equal(adminView.body.result.winner.userId, revealed.body.result.winner.userId);

  const csv = await call(api.handleExport, { method: "GET", headers: auth(ADMIN) }, late);
  assert.match(csv.body, /winner-secret/);
  assert.match(csv.body, /'=1\+1/);
  const publicCsv = await call(api.handleExport, { method: "GET" }, late);
  assert.equal(publicCsv.statusCode, 401);
});

test("upstash client does not leak the token", async () => {
  let seen;
  const client = createUpstashRedis("https://example.upstash.io/", "super-token", async (url, options) => {
    seen = { url, options };
    return { ok: true, async json() { return { result: "OK" }; } };
  });
  assert.equal(await client.command(["PING"]), "OK");
  assert.equal(seen.url, "https://example.upstash.io");
  assert.equal(seen.options.headers.Authorization, "Bearer super-token");
  const failing = createUpstashRedis("https://example.upstash.io", "super-token", async () => ({
    ok: false,
    status: 500,
    async text() { return "super-token failed"; },
  }));
  await assert.rejects(() => failing.command(["GET", "a"]), (error) => {
    assert.equal(error.message, "redis_http");
    assert.equal(error.message.includes("super-token"), false);
    return true;
  });
});

test("collector dedup, command and chat parsing", async () => {
  assert.equal(match.isExactCommand(" !GTA6 "), draw.isExactCommand(" !GTA6 "));
  assert.equal(match.isExactCommand("!gta6 extra"), false);
  const modern = extractTikTokChat({
    content: "!gta6",
    user: { id: "9001", displayId: "kipfan", nickname: "Fan" },
    common: { msgId: "abc", roomId: "77" },
  });
  assert.equal(modern.userId, "9001");
  assert.equal(modern.handle, "kipfan");
  const legacy = extractTikTokChat({ comment: "!gta6", userId: "12", uniqueId: "old", nickname: "Old" });
  assert.equal(legacy.userId, "12");
  assert.equal(legacy.handle, "old");
  const messages = extractMessages({
    items: [{
      id: "yt1",
      snippet: { type: "textMessageEvent", displayMessage: "!GTA6", publishedAt: "2026-12-10T12:00:00Z" },
      authorDetails: { channelId: "UCpublic", displayName: "Nume" },
    }, {
      id: "skip",
      snippet: { type: "superChatEvent", displayMessage: "!gta6" },
      authorDetails: { channelId: "UCx" },
    }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].userId, "UCpublic");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gta6-"));
  const store = createStore(dir);
  store.mark("tiktok\tu\tlive");
  store.mark("tiktok\tu\tlive");
  assert.equal(fs.readFileSync(path.join(dir, "seen.log"), "utf8"), "tiktok\tu\tlive\n");
  store.appendEvent({ type: "match" });
  assert.equal(createStore(dir).has("tiktok\tu\tlive"), true);

  let calls = 0;
  const posted = await postEntry({
    url: "https://kipzone.ro/api/giveaway/entry",
    secret: "s",
    payload: { command: "!gta6" },
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 503, async text() { return "{}"; } };
      return { ok: true, status: 201, async text() { return "{\"ok\":true,\"status\":\"created\"}"; } };
    },
  });
  assert.equal(posted.ok, true);
  assert.equal(calls, 3);
});

test("demo mode is local, labelled, and deterministic", async () => {
  assert.equal(demo.isDemo("?demo=1"), true);
  assert.equal(demo.isDemo("demo=1"), true);
  assert.equal(demo.isDemo("?demo=1&x=2"), true);
  assert.equal(demo.isDemo("?demo=true"), false);
  assert.equal(demo.isDemo(""), false);
  assert.equal(demo.BANNER, "SIMULARE – date de test");
  assert.equal(demo.RESERVES, 2);
  assert.ok(demo.ROSTER.length >= 25 && demo.ROSTER.length <= 40);
  const platforms = new Set(demo.ROSTER.map((row) => row[0]));
  assert.deepEqual([...platforms].sort(), ["tiktok", "youtube"]);
  for (const row of demo.ROSTER) {
    assert.match(row[1], /^test_/);
    assert.ok(row[2] >= 1 && row[2] <= 20);
  }
  const source = fs.readFileSync(path.join("giveaway", "demo.js"), "utf8");
  assert.equal(source.includes("fetch("), false);
  assert.equal(source.includes("UPSTASH"), false);
  const first = await demo.build(draw);
  const second = await demo.build(draw);
  assert.equal(first.participants, demo.ROSTER.length);
  assert.equal(first.entries, demo.ROSTER.reduce((sum, row) => sum + row[2], 0));
  assert.equal(first.commitHash, await draw.sha256Hex(demo.SEED));
  assert.equal(first.snapshotHash, await draw.sha256Hex(draw.canonicalJson(first.list)));
  assert.equal(first.reservePicks.length, 2);
  assert.equal(first.winner.handle.startsWith("test_"), true);
  assert.deepEqual(first.winner.key, second.winner.key);
  assert.deepEqual(first.reservePicks.map((row) => row.key), second.reservePicks.map((row) => row.key));
  assert.equal(JSON.stringify(first.list).includes("demo-test-"), false);
  const page = fs.readFileSync(path.join("giveaway", "page.js"), "utf8");
  const demoStart = page.indexOf("async function runDemo");
  const demoEnd = page.indexOf("const demo = window.GiveawayDemo");
  assert.equal(page.slice(demoStart, demoEnd).includes("fetch("), false);
});

test("demo seeds change the winner and large wheels stay readable", async () => {
  assert.equal(demo.demoCount("?demo=1&n=300"), 300);
  assert.equal(demo.demoCount("?demo=1&n=1000"), 1000);
  assert.equal(demo.demoCount("?demo=1&n=99999"), 5000);
  assert.equal(demo.demoCount("?demo=1"), 0);
  assert.equal(demo.demoCount("?n=300"), 0);
  assert.equal(demo.demoSeed("?demo=1&seed=abc"), "abc");
  assert.equal(demo.demoSeed("?seed=abc"), "");
  assert.notEqual(demo.randomSeed(), demo.randomSeed());
  const generated = demo.generatedRoster(300);
  assert.equal(generated.length, 300);
  assert.match(generated[0][1], /^test_/);
  assert.equal(generated[0][2] >= 1 && generated[0][2] <= 20, true);
  const prepared = await demo.prepare(draw, 0);
  const seeds = ["alpha-seed-0123456789", "beta-seed-0123456789", "gamma-seed-0123456789", "delta-seed-0123456789"];
  const winners = new Set();
  for (const seed of seeds) {
    const once = await demo.drawWith(draw, prepared, seed);
    const twice = await demo.drawWith(draw, prepared, seed);
    assert.equal(once.winner.key, twice.winner.key);
    assert.equal(once.commitHash, await draw.sha256Hex(seed));
    winners.add(once.winner.key);
  }
  assert.ok(winners.size >= 2);

  const heavy = [{ handle: "light", weight: 1 }, { handle: "heavy", weight: 20 }];
  const ratio = wheel.layoutSlices(heavy);
  assert.ok(Math.abs(ratio[1].arc / ratio[0].arc - 20) < 1e-9);
  const crowd = [];
  for (let index = 0; index < 1000; index++) crowd.push({ handle: "test_" + index, weight: 1 });
  const packed = wheel.layoutSlices(crowd);
  assert.equal(packed.length, 1000);
  assert.equal(packed.filter((slice) => slice.label).length, 0);
  const varied = wheel.layoutSlices(demo.ROSTER.map((row) => ({ handle: row[1], weight: row[2] })));
  const labeled = varied.filter((slice) => slice.label);
  assert.ok(labeled.length > 0);
  assert.ok(labeled.length < varied.length);
  for (let i = 0; i < labeled.length; i++) {
    assert.ok(labeled[i].arc >= wheel.MIN_LABEL_ARC);
    for (let j = i + 1; j < labeled.length; j++) {
      assert.ok(wheel.angularDistance(labeled[i].mid, labeled[j].mid) >= wheel.MIN_GAP - 1e-9);
    }
  }
});

test("pages stay on the site theme and out of the homepage", () => {
  const page = fs.readFileSync(path.join("giveaway", "index.html"), "utf8");
  const wheel = fs.readFileSync(path.join("giveaway", "extragere", "index.html"), "utf8");
  for (const html of [page, wheel]) {
    assert.match(html, /class="subpage"/);
    assert.match(html, /class="back"/);
    assert.match(html, /class="eyebrow"/);
    assert.match(html, /class="fineprint"/);
    assert.match(html, /href="\/style\.css/);
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i);
  }
  assert.match(page, /GIVEAWAY GTA 6/);
  assert.match(page, /id="gw-search"/);
  assert.match(page, /Clasament/);
  assert.match(page, /15000|15 secunde/);
  assert.equal(fs.readFileSync("index.html", "utf8").includes("/giveaway"), false);
  assert.equal(fs.readFileSync("sitemap.xml", "utf8").includes("giveaway"), false);
  const config = JSON.parse(fs.readFileSync("vercel.json", "utf8"));
  const giveaway = config.headers.find((item) => item.source === "/giveaway(.*)");
  assert.match(giveaway.headers[0].value, /script-src 'self'/);
  assert.match(giveaway.headers[0].value, /connect-src 'self'/);
});
