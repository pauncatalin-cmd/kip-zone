const https = require("https");
const http = require("http");
const { URL } = require("url");
const fallbackConfig = require("../followers.config.json");

const CACHE_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1600000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PLATFORMS = [
  { id: "kick", label: "Kick" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "discord", label: "Discord" },
];

let responseCache = { expires: 0, body: null };

function finiteInt(value) {
  if (typeof value === "string" && value.trim() !== "") value = Number(value);
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < 1 || rounded > 500000000) return null;
  return rounded;
}

function formatRo(value) {
  return new Intl.NumberFormat("ro-RO").format(value);
}

function headline(total) {
  if (total >= 1000) return formatRo(Math.floor(total / 100) * 100) + "+";
  return formatRo(total);
}

function fallbackCount(id) {
  return finiteInt(fallbackConfig[id]);
}

function allowedHost(hostname) {
  return (
    hostname === "kick.com" ||
    hostname.endsWith(".kick.com") ||
    hostname === "discord.com" ||
    hostname.endsWith(".discord.com") ||
    hostname === "www.googleapis.com" ||
    hostname === "youtube.com" ||
    hostname.endsWith(".youtube.com") ||
    hostname === "tiktok.com" ||
    hostname.endsWith(".tiktok.com")
  );
}

function request(url, options = {}) {
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
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      target,
      {
        method: "GET",
        headers: options.headers || {},
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (location && status >= 300 && status < 400 && (options.redirects || 0) < 3) {
          res.resume();
          const next = new URL(location, target);
          request(next.toString(), { ...options, redirects: (options.redirects || 0) + 1 }).then(resolve, reject);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error("too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function readJson(url, headers) {
  const response = await request(url, { headers });
  if (!response.ok) throw new Error("upstream");
  return JSON.parse(response.body);
}

function parseKick(data) {
  if (!data || data.slug !== "kipzone") return null;
  return finiteInt(data.followers_count);
}

function parseDiscord(data) {
  if (!data || data.code !== "9CwwfAAPdB") return null;
  return finiteInt(data.approximate_member_count);
}

function parseLooseCount(text) {
  const match = String(text).replace(/\u00a0/g, " ").match(/(\d+(?:[.,]\d+)?)\s*([KkMm])?/);
  if (!match) return null;
  let value = Number(match[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  const suffix = (match[2] || "").toLowerCase();
  if (suffix === "k") value *= 1000;
  if (suffix === "m") value *= 1000000;
  return finiteInt(value);
}

function parseYouTube(html) {
  const patterns = [
    /"content":"([^"]{0,48}(?:subscribers|subscriber|abonați|abonati)[^"]*)"/i,
    /"accessibilityLabel":"([^"]{0,48}(?:subscribers|subscriber|abonați|abonati)[^"]*)"/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const count = parseLooseCount(match[1]);
    if (count) return count;
  }
  return null;
}

function parseYouTubeApi(data) {
  const item = data && Array.isArray(data.items) ? data.items[0] : null;
  const stats = item && item.statistics;
  if (!stats || stats.hiddenSubscriberCount === true) return null;
  return finiteInt(stats.subscriberCount);
}

function parseTikTok(html) {
  const marker = html.indexOf('"uniqueId":"kipzone.ro"');
  if (marker === -1) return null;
  const match = html.slice(marker, marker + 12000).match(/"followerCount":(\d+)/);
  if (!match) return null;
  return finiteInt(match[1]);
}

async function countKick() {
  const data = await readJson("https://kick.com/api/v2/channels/kipzone", {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  const count = parseKick(data);
  if (!count) throw new Error("kick");
  return { count, via: "kick-v2" };
}

async function countDiscord() {
  const data = await readJson("https://discord.com/api/v9/invites/9CwwfAAPdB?with_counts=true", {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  });
  const count = parseDiscord(data);
  if (!count) throw new Error("discord");
  return { count, via: "discord-invite" };
}

async function countYouTube(env) {
  const key = env.YOUTUBE_API_KEY;
  if (key) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/channels");
      url.searchParams.set("part", "statistics");
      url.searchParams.set("id", "UCto-qi-euTHISWnC8SQ93oQ");
      url.searchParams.set("key", key);
      const data = await readJson(url.toString(), { Accept: "application/json" });
      const count = parseYouTubeApi(data);
      if (count) return { count, via: "youtube-api" };
    } catch (error) {
      /* The public channel page is the backup. */
    }
  }
  const response = await request("https://www.youtube.com/@kipanu", {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9,ro;q=0.8",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error("youtube");
  const count = parseYouTube(response.body);
  if (!count) throw new Error("youtube");
  return { count, via: "youtube-page" };
}

async function countTikTok() {
  const response = await request("https://www.tiktok.com/@kipzone.ro", {
    headers: {
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "User-Agent": USER_AGENT,
    },
  });
  if (!response.ok) throw new Error("tiktok");
  const count = parseTikTok(response.body);
  if (!count) throw new Error("tiktok");
  return { count, via: "tiktok-page" };
}

const LOADERS = {
  kick: countKick,
  discord: countDiscord,
  youtube: countYouTube,
  tiktok: countTikTok,
};

function platformResult(platform, result) {
  if (result) {
    return {
      id: platform.id,
      label: platform.label,
      count: result.count,
      formatted: formatRo(result.count),
      source: "live",
      via: result.via,
    };
  }
  const count = fallbackCount(platform.id);
  if (!count) return null;
  return {
    id: platform.id,
    label: platform.label,
    count,
    formatted: formatRo(count),
    source: "fallback",
    via: "snapshot",
  };
}

async function loadFollowers(env) {
  const runtimeEnv = env || process.env;
  const settled = await Promise.all(
    PLATFORMS.map(async (platform) => {
      try {
        return await LOADERS[platform.id](runtimeEnv);
      } catch (error) {
        return null;
      }
    })
  );
  const platforms = PLATFORMS.map((platform, index) => platformResult(platform, settled[index])).filter(Boolean);
  const total = platforms.reduce((sum, platform) => sum + platform.count, 0);
  const display = total > 0 ? headline(total) : "";
  return {
    total,
    display,
    text: display ? display + " urmăritori pe toate platformele" : "",
    platforms,
  };
}

async function handler(req, res) {
  try {
    const now = Date.now();
    if (!responseCache.body || responseCache.expires <= now) {
      responseCache = {
        expires: now + CACHE_MS,
        body: await loadFollowers(),
      };
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(responseCache.body);
  } catch (error) {
    const platforms = PLATFORMS.map((platform) => platformResult(platform, null)).filter(Boolean);
    const total = platforms.reduce((sum, platform) => sum + platform.count, 0);
    const display = total > 0 ? headline(total) : "";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=3600");
    res.status(200).json({
      total,
      display,
      text: display ? display + " urmăritori pe toate platformele" : "",
      platforms,
    });
  }
}

module.exports = handler;
module.exports.loadFollowers = loadFollowers;
module.exports.parseKick = parseKick;
module.exports.parseDiscord = parseDiscord;
module.exports.parseYouTube = parseYouTube;
module.exports.parseYouTubeApi = parseYouTubeApi;
module.exports.parseTikTok = parseTikTok;
module.exports.headline = headline;
module.exports.formatRo = formatRo;
module.exports._resetCache = function resetCache() {
  responseCache = { expires: 0, body: null };
};
