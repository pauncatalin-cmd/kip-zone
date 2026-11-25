const crypto = require("crypto");
const draw = require("../../giveaway/draw-math");
const { redisFromEnv } = require("./redis");

const KEY = {
  bans: "gta6:bans",
  banReasons: "gta6:banreasons",
  log: "gta6:log",
  lives: "gta6:lives",
  roster: "gta6:roster",
  commit: "gta6:commit",
  closed: "gta6:closed",
  snapshot: "gta6:snapshot",
  reveal: "gta6:reveal",
};

const PLATFORMS = new Set(["tiktok", "youtube"]);

function safeEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(right), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const header = req.headers && (req.headers.authorization || req.headers.Authorization) || "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header).trim());
  return match ? match[1] : "";
}

function authorized(req, secret) {
  if (!secret) return false;
  return safeEqual(bearer(req), secret);
}

function adminSecret(env) {
  if (env.GIVEAWAY_ADMIN_SECRET) return env.GIVEAWAY_ADMIN_SECRET;
  return env.GIVEAWAY_INGEST_SECRET || "";
}

function sendJson(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

function sendText(res, status, body, headers) {
  res.setHeader("Cache-Control", "no-store");
  for (const [name, value] of Object.entries(headers || {})) res.setHeader(name, value);
  res.status(status).send(body);
}

function result(status, body) {
  return { status, body };
}

function fail(status, error, message) {
  return result(status, { ok: false, error, message });
}

async function readJson(req) {
  if (Buffer.isBuffer(req.body)) {
    if (!req.body.length) return {};
    return JSON.parse(req.body.toString("utf8"));
  }
  if (typeof req.body === "string") {
    if (!req.body) return {};
    return JSON.parse(req.body);
  }
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) return req.body;
  if (!req || typeof req[Symbol.asyncIterator] !== "function") return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 16384) {
      const error = new Error("too_large");
      error.status = 413;
      throw error;
    }
    chunks.push(buf);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function envOf(overrides) {
  return (overrides && overrides.env) || process.env;
}

function nowOf(overrides) {
  if (overrides && typeof overrides.now === "function") return overrides.now();
  return Date.now();
}

async function redisOf(overrides) {
  if (overrides && overrides.redis) return { ok: true, client: overrides.redis };
  return redisFromEnv(envOf(overrides));
}

function notConfigured(info) {
  return fail(503, "not_configured", (info && info.message) || "Evidența giveaway-ului nu este configurată.");
}

function method(req) {
  return String((req && req.method) || "GET").toUpperCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function queryValue(req, name) {
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, name)) {
    const value = req.query[name];
    return Array.isArray(value) ? String(value[0] || "") : String(value == null ? "" : value);
  }
  try {
    const url = new URL(req.url || "/", "http://localhost");
    return url.searchParams.get(name) || "";
  } catch (error) {
    return "";
  }
}

function parseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 0 && value < 1e12) return Math.round(value * 1000);
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return parseTime(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned) return "";
  return cleaned.slice(0, max);
}

function cleanId(value, max) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (!cleaned || cleaned.length > max) return null;
  if (/[\u0000-\u001F\u007F]/.test(cleaned)) return null;
  return cleaned;
}

function bucharestDate(ms) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: draw.CAMPAIGN.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function windowState(now, closed) {
  const openMs = Date.parse(draw.CAMPAIGN.open);
  const closeMs = Date.parse(draw.CAMPAIGN.close);
  return {
    open: now >= openMs && now < closeMs && !closed,
    openAt: draw.CAMPAIGN.open,
    closeAt: draw.CAMPAIGN.close,
    timeZone: draw.CAMPAIGN.timeZone,
  };
}

function banId(platform, userId) {
  return platform + "\0" + userId;
}

function seenKey(platform, userId, liveId) {
  return "gta6:seen:" + platform + ":" + encodeURIComponent(userId) + ":" + encodeURIComponent(liveId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock(redis, key, fn) {
  const lockKey = "gta6:lock:" + key;
  for (let attempt = 0; attempt < 25; attempt++) {
    const locked = await redis.command(["SET", lockKey, "1", "NX", "EX", "5"]);
    if (locked === "OK") {
      try {
        return await fn();
      } finally {
        await redis.command(["DEL", lockKey]);
      }
    }
    await delay(30 + attempt * 20);
  }
  const error = new Error("lock");
  error.code = "redis";
  throw error;
}

function validateEntry(body, now) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "bad_request", "Datele intrării nu sunt valide.");
  }
  const platform = typeof body.platform === "string" ? body.platform.trim().toLowerCase() : "";
  if (!PLATFORMS.has(platform)) {
    return fail(400, "bad_request", "Platforma trebuie să fie tiktok sau youtube.");
  }
  const userId = cleanId(body.userId, 128);
  const liveId = cleanId(body.liveId, 128);
  const messageId = cleanId(body.messageId, 160);
  if (!userId || !liveId || !messageId) {
    return fail(400, "bad_request", "userId, liveId și messageId sunt obligatorii.");
  }
  let handle = cleanText(body.handle, 80);
  let displayName = cleanText(body.displayName, 80);
  if (!handle) handle = displayName;
  if (!displayName) displayName = handle;
  if (!handle) return fail(400, "bad_request", "Lipsește numele contului.");
  if (!draw.isExactCommand(body.command)) {
    return fail(400, "command", "Comanda trebuie să fie exact !gta6.");
  }
  const ts = parseTime(body.ts);
  if (ts == null) return fail(400, "bad_request", "Lipsește momentul mesajului.");
  if (ts > now + draw.CAMPAIGN.skewMs) {
    return fail(400, "bad_request", "Momentul mesajului este în viitor.");
  }
  const openMs = Date.parse(draw.CAMPAIGN.open);
  const closeMs = Date.parse(draw.CAMPAIGN.close);
  if (ts < openMs || ts >= closeMs) {
    return fail(403, "window", "Mesajul este în afara perioadei de înscriere (1–24 decembrie 2026, până la ora 20:00, Europa/București).");
  }
  let accountCreatedAt = null;
  if (body.accountCreatedAt != null && body.accountCreatedAt !== "") {
    accountCreatedAt = parseTime(body.accountCreatedAt);
    if (accountCreatedAt == null) {
      return fail(400, "bad_request", "accountCreatedAt nu este o dată validă.");
    }
    if (ts - accountCreatedAt < draw.CAMPAIGN.minAccountAgeMs) {
      return fail(403, "account_age", "Contul trebuie să aibă cel puțin 7 zile în momentul mesajului.");
    }
  }
  return {
    ok: true,
    entry: {
      platform,
      userId,
      handle,
      displayName,
      liveId,
      ts,
      date: bucharestDate(ts),
      messageId,
      accountCreatedAt,
    },
  };
}

async function isClosed(redis) {
  const closed = await redis.command(["GET", KEY.closed]);
  if (closed) return true;
  const snapshot = await redis.command(["GET", KEY.snapshot]);
  return Boolean(snapshot);
}

async function recordEntry(redis, entry) {
  if (Number(await redis.command(["SISMEMBER", KEY.bans, banId(entry.platform, entry.userId)])) === 1) {
    return fail(403, "banned", "Acest cont nu poate participa.");
  }
  if (await isClosed(redis)) {
    return fail(403, "frozen", "Înscrierile sunt închise pentru extragere.");
  }
  const key = await draw.participantKey(entry.platform, entry.userId);
  const marker = seenKey(entry.platform, entry.userId, entry.liveId);
  const line = JSON.stringify(entry);
  const created = await redis.command(["SET", marker, line, "NX"]);
  if (created !== "OK") {
    const raw = await redis.command(["HGET", KEY.roster, key]);
    let entries = null;
    if (raw) {
      try {
        entries = JSON.parse(raw).lives.length;
      } catch (error) {
        entries = null;
      }
    }
    return result(200, { ok: true, status: "duplicate", entries });
  }
  try {
    const entries = await withLock(redis, key, async () => {
      if (await isClosed(redis)) {
        const error = new Error("frozen");
        error.code = "frozen";
        throw error;
      }
      const raw = await redis.command(["HGET", KEY.roster, key]);
      const roster = raw ? JSON.parse(raw) : {
        platform: entry.platform,
        userId: entry.userId,
        handle: entry.handle,
        displayName: entry.displayName,
        lives: [],
      };
      roster.platform = entry.platform;
      roster.userId = entry.userId;
      roster.handle = entry.handle;
      roster.displayName = entry.displayName;
      roster.lives.push({
        liveId: entry.liveId,
        ts: entry.ts,
        date: entry.date,
        messageId: entry.messageId,
      });
      await redis.pipeline([
        ["HSET", KEY.roster, key, JSON.stringify(roster)],
        ["SADD", KEY.lives, entry.liveId],
        ["RPUSH", KEY.log, line],
      ]);
      return roster.lives.length;
    });
    return result(201, { ok: true, status: "created", entries });
  } catch (error) {
    await redis.command(["DEL", marker]);
    if (error && error.code === "frozen") {
      return fail(403, "frozen", "Înscrierile sunt închise pentru extragere.");
    }
    throw error;
  }
}

function normalizeQuery(value) {
  return String(value || "")
    .replace(/^@+/, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function publicSearchHit(row) {
  return {
    platform: row.platform,
    handle: row.handle,
    displayName: row.displayName,
    entries: row.lives.length,
    dates: [...new Set(row.lives.map((live) => live.date))].sort(),
  };
}

async function loadRoster(redis) {
  const banned = new Set(asArray(await redis.command(["SMEMBERS", KEY.bans])));
  const flat = asArray(await redis.command(["HGETALL", KEY.roster]));
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) {
    let row;
    try {
      row = JSON.parse(flat[i + 1]);
    } catch (error) {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    if (banned.has(banId(row.platform, row.userId))) continue;
    rows.push(row);
  }
  return rows;
}

function rosterEntries(row) {
  return Array.isArray(row.lives) ? row.lives.length : 0;
}

async function searchRoster(redis, q) {
  const needle = normalizeQuery(q);
  if (needle.length < 2) {
    return fail(400, "bad_request", "Scrie cel puțin 2 caractere.");
  }
  if (needle.length > 40) {
    return fail(400, "bad_request", "Căutarea este prea lungă.");
  }
  const hits = [];
  for (const row of await loadRoster(redis)) {
    const handle = normalizeQuery(row.handle);
    const displayName = normalizeQuery(row.displayName);
    if (handle.includes(needle) || displayName.includes(needle)) hits.push(publicSearchHit(row));
  }
  hits.sort((a, b) => b.entries - a.entries || a.handle.localeCompare(b.handle, "ro"));
  return result(200, { ok: true, configured: true, q: cleanText(q, 40), results: hits.slice(0, 20) });
}

function rankLeaders(rows) {
  return rows
    .map((row) => ({
      platform: row.platform,
      handle: row.handle,
      displayName: row.displayName,
      entries: rosterEntries(row),
    }))
    .filter((row) => row.entries > 0 && row.handle)
    .sort((a, b) => b.entries - a.entries || a.handle.localeCompare(b.handle, "ro") || a.platform.localeCompare(b.platform));
}

function parseStored(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

async function readStats(redis, now) {
  const rows = await loadRoster(redis);
  const participants = rows.length;
  const entries = rows.reduce((sum, row) => sum + rosterEntries(row), 0);
  const liveIds = new Set();
  for (const row of rows) {
    for (const live of row.lives || []) liveIds.add(live.liveId);
  }
  const lives = liveIds.size;
  const closed = await isClosed(redis);
  const commit = parseStored(await redis.command(["GET", KEY.commit]));
  const reveal = parseStored(await redis.command(["GET", KEY.reveal]));
  const state = windowState(now, closed);
  return {
    ok: true,
    configured: true,
    participants,
    entries,
    lives,
    open: state.open,
    frozen: closed,
    committed: Boolean(commit && commit.hash),
    commitHash: commit && commit.hash ? commit.hash : null,
    revealed: Boolean(reveal),
    now: new Date(now).toISOString(),
    window: {
      open: state.openAt,
      close: state.closeAt,
      timeZone: state.timeZone,
    },
  };
}

async function readLog(redis) {
  const lines = asArray(await redis.command(["LRANGE", KEY.log, "0", "-1"]));
  const entries = [];
  for (const line of lines || []) {
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      /* Skip a damaged line rather than fail the whole draw. */
    }
  }
  return entries;
}

async function buildSnapshot(entries, banned) {
  const map = new Map();
  for (const entry of entries) {
    if (banned.has(banId(entry.platform, entry.userId))) continue;
    const key = await draw.participantKey(entry.platform, entry.userId);
    let row = map.get(key);
    if (!row) {
      row = {
        key,
        platform: entry.platform,
        handle: entry.handle,
        displayName: entry.displayName,
        weight: 0,
        dates: [],
      };
      map.set(key, row);
    }
    row.handle = entry.handle;
    row.displayName = entry.displayName;
    row.weight += 1;
    if (!row.dates.includes(entry.date)) row.dates.push(entry.date);
  }
  const list = [...map.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const row of list) row.dates.sort();
  const canonical = draw.canonicalJson(list);
  return {
    hash: await draw.sha256Hex(canonical),
    canonical,
    participants: list.length,
    entries: list.reduce((sum, row) => sum + row.weight, 0),
  };
}

function publicPerson(row) {
  return {
    key: row.key,
    platform: row.platform,
    handle: row.handle,
    displayName: row.displayName,
    entries: row.weight,
    dates: row.dates,
  };
}

async function withUserId(redis, person) {
  const raw = await redis.command(["HGET", KEY.roster, person.key]);
  if (!raw) return person;
  try {
    const roster = JSON.parse(raw);
    return { ...person, userId: roster.userId };
  } catch (error) {
    return person;
  }
}

async function drawView(redis, admin, full) {
  const commit = parseStored(await redis.command(["GET", KEY.commit]));
  const snapshot = parseStored(await redis.command(["GET", KEY.snapshot]));
  const reveal = parseStored(await redis.command(["GET", KEY.reveal]));
  const view = {
    ok: true,
    configured: true,
    commit: commit ? { hash: commit.hash, at: commit.at } : null,
    snapshot: snapshot
      ? {
          hash: snapshot.hash,
          participants: snapshot.participants,
          entries: snapshot.entries,
          at: snapshot.at,
        }
      : null,
    result: null,
  };
  if (snapshot && full === true) {
    view.snapshot.list = JSON.parse(snapshot.canonical);
  }
  if (reveal && snapshot) {
    const list = JSON.parse(snapshot.canonical);
    const byKey = new Map(list.map((row) => [row.key, row]));
    async function person(key) {
      const row = byKey.get(key);
      if (!row) return null;
      const pub = publicPerson(row);
      return admin ? withUserId(redis, pub) : pub;
    }
    view.result = {
      at: reveal.at,
      seed: reveal.seed,
      commitHash: reveal.commitHash,
      snapshotHash: reveal.snapshotHash,
      winner: await person(reveal.winnerKey),
      reserves: [],
    };
    for (const key of reveal.reserveKeys || []) {
      const row = await person(key);
      if (row) view.result.reserves.push(row);
    }
  }
  return view;
}

function requireAdmin(req, env) {
  const secret = adminSecret(env);
  if (!secret) {
    return fail(503, "not_configured", "Lipsește GIVEAWAY_ADMIN_SECRET (sau GIVEAWAY_INGEST_SECRET, dacă nu folosești un secret separat).");
  }
  if (!authorized(req, secret)) return fail(401, "unauthorized", "Neautorizat.");
  return null;
}

async function handleEntry(req, res, overrides) {
  try {
    if (method(req) !== "POST") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește POST." });
      return;
    }
    const env = envOf(overrides);
    if (!env.GIVEAWAY_INGEST_SECRET) {
      sendJson(res, 503, {
        ok: false,
        configured: false,
        error: "not_configured",
        message: "Lipsește GIVEAWAY_INGEST_SECRET.",
      });
      return;
    }
    if (!authorized(req, env.GIVEAWAY_INGEST_SECRET)) {
      sendJson(res, 401, { ok: false, error: "unauthorized", message: "Neautorizat." });
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      sendJson(res, 503, body);
      return;
    }
    let payload;
    try {
      payload = await readJson(req);
    } catch (error) {
      const status = error && error.status === 413 ? 413 : 400;
      sendJson(res, status, { ok: false, error: status === 413 ? "too_large" : "bad_json", message: "JSON invalid." });
      return;
    }
    const parsed = validateEntry(payload, nowOf(overrides));
    if (!parsed.ok) {
      sendJson(res, parsed.status, parsed.body);
      return;
    }
    const saved = await recordEntry(redis.client, parsed.entry);
    sendJson(res, saved.status, saved.body);
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Evidența nu a putut fi actualizată. Încearcă din nou." });
  }
}

async function changeBan(req, res, overrides, banned) {
  try {
    if (method(req) !== "POST") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește POST." });
      return;
    }
    const denied = requireAdmin(req, envOf(overrides));
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      sendJson(res, 503, body);
      return;
    }
    let payload;
    try {
      payload = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "JSON invalid." });
      return;
    }
    const platform = payload && typeof payload.platform === "string" ? payload.platform.trim().toLowerCase() : "";
    const userId = payload ? cleanId(payload.userId, 128) : null;
    if (!PLATFORMS.has(platform) || !userId) {
      sendJson(res, 400, { ok: false, error: "bad_request", message: "platform și userId sunt obligatorii." });
      return;
    }
    const id = banId(platform, userId);
    if (banned) {
      const reason = payload.reason ? cleanText(String(payload.reason), 200) : "";
      await redis.client.pipeline([
        ["SADD", KEY.bans, id],
        ["HSET", KEY.banReasons, id, reason],
      ]);
      sendJson(res, 200, { ok: true, status: "banned" });
      return;
    }
    await redis.client.pipeline([
      ["SREM", KEY.bans, id],
      ["HSET", KEY.banReasons, id, ""],
    ]);
    sendJson(res, 200, { ok: true, status: "unbanned" });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Evidența nu a putut fi actualizată. Încearcă din nou." });
  }
}

async function handleBan(req, res, overrides) {
  return changeBan(req, res, overrides, true);
}

async function handleUnban(req, res, overrides) {
  return changeBan(req, res, overrides, false);
}

async function handleSearch(req, res, overrides) {
  try {
    if (method(req) !== "GET") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește GET." });
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      body.results = [];
      sendJson(res, 503, body);
      return;
    }
    const found = await searchRoster(redis.client, queryValue(req, "q"));
    sendJson(res, found.status, found.body);
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Evidența nu a putut fi citită. Încearcă din nou." });
  }
}

async function handleStats(req, res, overrides) {
  try {
    if (method(req) !== "GET") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește GET." });
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      body.participants = null;
      body.entries = null;
      body.lives = null;
      body.open = false;
      sendJson(res, 503, body);
      return;
    }
    sendJson(res, 200, await readStats(redis.client, nowOf(overrides)));
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Evidența nu a putut fi citită. Încearcă din nou." });
  }
}

async function handleDraw(req, res, overrides) {
  try {
    const env = envOf(overrides);
    const verb = method(req);
    if (verb === "GET") {
      const redis = await redisOf(overrides);
      if (!redis.ok) {
        const body = notConfigured(redis).body;
        body.configured = false;
        body.commit = null;
        body.snapshot = null;
        body.result = null;
        sendJson(res, 503, body);
        return;
      }
      const admin = Boolean(adminSecret(env) && authorized(req, adminSecret(env)));
      const full = queryValue(req, "full") === "1";
      const view = await drawView(redis.client, admin, full);
      const stats = await readStats(redis.client, nowOf(overrides));
      view.open = stats.open;
      view.frozen = stats.frozen;
      sendJson(res, 200, view);
      return;
    }
    if (verb !== "POST") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește GET sau POST." });
      return;
    }
    const denied = requireAdmin(req, env);
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      sendJson(res, 503, body);
      return;
    }
    let payload;
    try {
      payload = await readJson(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: "bad_json", message: "JSON invalid." });
      return;
    }
    const action = payload && typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";
    if (action === "commit") {
      const saved = await commitSeed(redis.client, payload.seed, nowOf(overrides));
      sendJson(res, saved.status, saved.body);
      return;
    }
    if (action === "freeze") {
      const saved = await freezeSnapshot(redis.client, nowOf(overrides));
      sendJson(res, saved.status, saved.body);
      return;
    }
    if (action === "reveal") {
      const saved = await revealSeed(redis.client, payload.seed, nowOf(overrides));
      sendJson(res, saved.status, saved.body);
      return;
    }
    sendJson(res, 400, { ok: false, error: "bad_request", message: "Acțiunea trebuie să fie commit, freeze sau reveal." });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Extragerea nu a putut fi procesată. Încearcă din nou." });
  }
}

async function commitSeed(redis, seed, now) {
  if (typeof seed !== "string") return fail(400, "bad_request", "Seed-ul lipsește.");
  const trimmed = seed.trim();
  if (trimmed.length < 16 || trimmed.length > 512) {
    return fail(400, "bad_request", "Seed-ul trebuie să aibă între 16 și 512 caractere. Păstrează-l la tine: serverul nu îl salvează acum.");
  }
  if (await redis.command(["GET", KEY.commit])) {
    return fail(409, "conflict", "Hash-ul de angajament este deja publicat.");
  }
  if (await redis.command(["GET", KEY.snapshot])) {
    return fail(409, "conflict", "Lista este deja înghețată.");
  }
  const stored = JSON.stringify({
    hash: await draw.sha256Hex(trimmed),
    at: new Date(now).toISOString(),
  });
  const set = await redis.command(["SET", KEY.commit, stored, "NX"]);
  if (set !== "OK") return fail(409, "conflict", "Hash-ul de angajament este deja publicat.");
  const saved = JSON.parse(stored);
  return result(200, {
    ok: true,
    status: "committed",
    hash: saved.hash,
    at: saved.at,
    message: "Seed-ul nu a fost salvat. Păstrează-l până la extragerea live.",
  });
}

async function freezeSnapshot(redis, now) {
  if (now < Date.parse(draw.CAMPAIGN.close)) {
    return fail(409, "too_early", "Lista se îngheață la extragere, din 24 decembrie 2026, ora 20:00 (Europa/București).");
  }
  if (!(await redis.command(["GET", KEY.commit]))) {
    return fail(409, "conflict", "Publică mai întâi hash-ul seed-ului.");
  }
  if (await redis.command(["GET", KEY.snapshot])) {
    return fail(409, "conflict", "Lista este deja înghețată.");
  }
  await redis.command(["SET", KEY.closed, "1"]);
  const banned = new Set(asArray(await redis.command(["SMEMBERS", KEY.bans])));
  const built = await buildSnapshot(await readLog(redis), banned);
  const stored = JSON.stringify({ ...built, at: new Date(now).toISOString() });
  const set = await redis.command(["SET", KEY.snapshot, stored, "NX"]);
  if (set !== "OK") return fail(409, "conflict", "Lista este deja înghețată.");
  return result(200, {
    ok: true,
    status: "frozen",
    hash: built.hash,
    participants: built.participants,
    entries: built.entries,
    at: JSON.parse(stored).at,
  });
}

async function revealSeed(redis, seed, now) {
  if (typeof seed !== "string" || !seed.trim()) return fail(400, "bad_request", "Seed-ul lipsește.");
  const commit = parseStored(await redis.command(["GET", KEY.commit]));
  const snapshot = parseStored(await redis.command(["GET", KEY.snapshot]));
  if (!commit) return fail(409, "conflict", "Nu există un hash de angajament.");
  if (!snapshot) return fail(409, "conflict", "Lista nu este înghețată.");
  if (await redis.command(["GET", KEY.reveal])) return fail(409, "conflict", "Extragerea a fost deja făcută.");
  const trimmed = seed.trim();
  const hash = await draw.sha256Hex(trimmed);
  if (!safeEqual(hash, String(commit.hash || "").toLowerCase())) {
    return fail(403, "seed", "Seed-ul nu se potrivește cu hash-ul publicat.");
  }
  const list = JSON.parse(snapshot.canonical);
  if (!list.length) return fail(409, "empty", "Nu există intrări eligibile în lista înghețată.");
  const drawn = await draw.drawWinners(list, trimmed, snapshot.hash, draw.CAMPAIGN.reserves);
  if (!drawn.picks.length) return fail(409, "empty", "Nu există intrări eligibile în lista înghețată.");
  const stored = {
    at: new Date(now).toISOString(),
    seed: trimmed,
    commitHash: commit.hash,
    snapshotHash: snapshot.hash,
    counter: drawn.counter,
    winnerKey: drawn.picks[0].key,
    reserveKeys: drawn.picks.slice(1).map((row) => row.key),
  };
  const set = await redis.command(["SET", KEY.reveal, JSON.stringify(stored), "NX"]);
  if (set !== "OK") return fail(409, "conflict", "Extragerea a fost deja făcută.");
  const view = await drawView(redis, true, false);
  return result(200, { ok: true, status: "revealed", result: view.result });
}

function csvCell(value) {
  let text = value == null ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

async function handleLeaderboard(req, res, overrides) {
  try {
    if (method(req) !== "GET") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește GET." });
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      body.participants = null;
      body.entries = null;
      body.leaders = [];
      sendJson(res, 503, body);
      return;
    }
    const ranked = rankLeaders(await loadRoster(redis.client));
    sendJson(res, 200, {
      ok: true,
      configured: true,
      participants: ranked.length,
      entries: ranked.reduce((sum, row) => sum + row.entries, 0),
      leaders: ranked.slice(0, 20),
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Clasamentul nu a putut fi citit. Încearcă din nou." });
  }
}

async function handleExport(req, res, overrides) {
  try {
    if (method(req) !== "GET") {
      sendJson(res, 405, { ok: false, error: "method", message: "Folosește GET." });
      return;
    }
    const denied = requireAdmin(req, envOf(overrides));
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }
    const redis = await redisOf(overrides);
    if (!redis.ok) {
      const body = notConfigured(redis).body;
      body.configured = false;
      sendJson(res, 503, body);
      return;
    }
    const banned = new Set(asArray(await redis.client.command(["SMEMBERS", KEY.bans])));
    const lines = ["platform,userId,handle,displayName,liveId,date,timestamp,messageId,accountCreatedAt,banned"];
    for (const entry of await readLog(redis.client)) {
      lines.push([
        entry.platform,
        entry.userId,
        entry.handle,
        entry.displayName,
        entry.liveId,
        entry.date,
        new Date(entry.ts).toISOString(),
        entry.messageId,
        entry.accountCreatedAt == null ? "" : new Date(entry.accountCreatedAt).toISOString(),
        banned.has(banId(entry.platform, entry.userId)) ? "yes" : "no",
      ].map(csvCell).join(","));
    }
    sendText(res, 200, "\uFEFF" + lines.join("\r\n") + "\r\n", {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=\"gta6-entries.csv\"",
    });
  } catch (error) {
    sendJson(res, 502, { ok: false, error: "redis", message: "Exportul nu a putut fi făcut. Încearcă din nou." });
  }
}

module.exports = {
  KEY,
  handleEntry,
  handleBan,
  handleUnban,
  handleSearch,
  handleStats,
  handleLeaderboard,
  handleDraw,
  handleExport,
  validateEntry,
  buildSnapshot,
  publicSearchHit,
};
