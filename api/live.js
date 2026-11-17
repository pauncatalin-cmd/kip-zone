const https = require("https");
const http = require("http");
const { URL } = require("url");

const SLUG = "kipzone";
const USER_ID = 74689532;
const SUCCESS_TTL_MS = 60 * 1000;
const FAILURE_TTL_MS = 15 * 1000;
const UPSTREAM_TIMEOUT_MS = 3500;

// Kick's edge accepts this public channel read and rejects some non-browser
// clients. The playback URL inside the upstream document is never returned.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let responseCache = { expires: 0, body: null, cacheControl: "" };
let tokenCache = { token: "", expires: 0 };

function finiteInt(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

function cleanTitle(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 140);
}

function offline() {
  return { live: false, viewers: null, title: null };
}

function parseChannel(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  if (data.slug !== SLUG && Number(data.user_id) !== USER_ID) return null;
  const stream = data.livestream;
  if (stream == null) return offline();
  if (typeof stream !== "object" || Array.isArray(stream)) return null;
  if (stream.is_live !== true && stream.is_live !== 1) return offline();
  return {
    live: true,
    viewers: finiteInt(stream.viewer_count),
    title: cleanTitle(stream.session_title),
  };
}

function parseLivestream(data) {
  if (!data || typeof data !== "object" || !("data" in data)) return null;
  const stream = data.data;
  if (stream == null) return offline();
  if (typeof stream !== "object" || Array.isArray(stream)) return null;
  const viewers = stream.viewers != null ? stream.viewers : stream.viewer_count;
  return {
    live: true,
    viewers: finiteInt(viewers),
    title: cleanTitle(stream.session_title || stream.title),
  };
}

function parseOfficial(body) {
  if (!body || !Array.isArray(body.data)) return null;
  const match = body.data.find((item) => {
    if (!item || typeof item !== "object") return false;
    const slug = item.slug || (item.channel && item.channel.slug);
    const id = Number(
      item.broadcaster_user_id != null
        ? item.broadcaster_user_id
        : item.broadcaster_user && item.broadcaster_user.id
    );
    return slug === SLUG || id === USER_ID;
  });
  if (!match) return offline();
  return {
    live: true,
    viewers: finiteInt(match.viewer_count),
    title: cleanTitle(match.title || match.stream_title),
  };
}

function allowedHost(hostname) {
  return hostname === "kick.com" || hostname.endsWith(".kick.com");
}

function nodeFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (!allowedHost(target.hostname)) {
      reject(new Error("host"));
      return;
    }
    const headers = { ...(options.headers || {}) };
    const body = options.body == null ? null : String(options.body);
    if (body != null && headers["Content-Length"] == null && headers["content-length"] == null) {
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(target, {
      method: options.method || "GET",
      headers,
    }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (location && status >= 300 && status < 400 && (options.redirects || 0) < 3) {
        res.resume();
        const next = new URL(location, target);
        nodeFetch(next.toString(), { ...options, redirects: (options.redirects || 0) + 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: {
            get(name) {
              const value = res.headers[String(name).toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : value || "";
            },
          },
          json: async () => JSON.parse(raw),
        });
      });
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function fetchJson(fetchImpl, url, options) {
  const response = await fetchImpl(url, options || {});
  if (!response.ok) {
    const error = new Error("upstream");
    error.status = response.status;
    throw error;
  }
  const type = response.headers.get("content-type") || "";
  if (!type.includes("json")) throw new Error("not json");
  return response.json();
}

async function appToken(env, fetchImpl) {
  const now = Date.now();
  if (tokenCache.token && tokenCache.expires > now) return tokenCache.token;
  const response = await fetchJson(fetchImpl, "https://id.kick.com/oauth/token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.KICK_CLIENT_ID,
      client_secret: env.KICK_CLIENT_SECRET,
    }),
  });
  if (!response.access_token || typeof response.access_token !== "string") {
    throw new Error("token");
  }
  const ttl = Number(response.expires_in);
  tokenCache = {
    token: response.access_token,
    expires: now + (Number.isFinite(ttl) ? Math.max(30, ttl - 60) * 1000 : 10 * 60 * 1000),
  };
  return tokenCache.token;
}

async function fetchOfficial(env, fetchImpl) {
  const token = await appToken(env, fetchImpl);
  const body = await fetchJson(
    fetchImpl,
    `https://api.kick.com/public/v1/users/livestreams?user_id=${USER_ID}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    }
  );
  return parseOfficial(body);
}

async function loadLiveStatus(env, fetchImpl) {
  const runtimeEnv = env || process.env;
  const runtimeFetch = fetchImpl || nodeFetch;
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT };

  try {
    const channel = await fetchJson(
      runtimeFetch,
      `https://kick.com/api/v2/channels/${SLUG}`,
      { headers }
    );
    const parsed = parseChannel(channel);
    if (parsed) return { ...parsed, ok: true, source: "kick-v2" };
  } catch (error) {
    /* The website API is often blocked. Try the next source. */
  }

  try {
    const livestream = await fetchJson(
      runtimeFetch,
      `https://kick.com/api/v2/channels/${SLUG}/livestream`,
      { headers }
    );
    const parsed = parseLivestream(livestream);
    if (parsed) return { ...parsed, ok: true, source: "kick-v2-livestream" };
  } catch (error) {
    /* Fall through to the official API when credentials exist. */
  }

  if (runtimeEnv.KICK_CLIENT_ID && runtimeEnv.KICK_CLIENT_SECRET) {
    try {
      const parsed = await fetchOfficial(runtimeEnv, runtimeFetch);
      if (parsed) return { ...parsed, ok: true, source: "kick-official" };
    } catch (error) {
      /* Fail silent below. */
    }
  }

  return { ...offline(), ok: false, source: null };
}

function publicBody(status) {
  return {
    live: status.live === true,
    viewers: Number.isFinite(status.viewers) ? status.viewers : null,
    title: typeof status.title === "string" ? status.title : null,
    channel: SLUG,
    ok: status.ok === true,
    source: status.ok === true ? status.source : null,
  };
}

async function handler(req, res) {
  try {
    const now = Date.now();
    if (!responseCache.body || responseCache.expires <= now) {
      const status = await loadLiveStatus();
      const cacheControl = status.ok
        ? "public, max-age=60, s-maxage=60, stale-while-revalidate=30"
        : "public, max-age=0, s-maxage=15";
      responseCache = {
        expires: now + (status.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
        body: publicBody(status),
        cacheControl,
      };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", responseCache.cacheControl);
    res.status(200).json(responseCache.body);
  } catch (error) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ...publicBody(offline()), ok: false, source: null });
  }
}

module.exports = handler;
module.exports.loadLiveStatus = loadLiveStatus;
module.exports.parseChannel = parseChannel;
module.exports.parseLivestream = parseLivestream;
module.exports.parseOfficial = parseOfficial;
module.exports.publicBody = publicBody;
module.exports._resetCache = function resetCache() {
  responseCache = { expires: 0, body: null, cacheControl: "" };
  tokenCache = { token: "", expires: 0 };
};
