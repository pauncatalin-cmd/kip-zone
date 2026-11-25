const { URL } = require("url");

function createMemoryRedis() {
  const strings = new Map();
  const expiry = new Map();
  const hashes = new Map();
  const sets = new Map();
  const lists = new Map();

  function purge(key) {
    const exp = expiry.get(key);
    if (exp != null && exp <= Date.now()) {
      strings.delete(key);
      expiry.delete(key);
    }
  }

  function hashOf(key) {
    let hash = hashes.get(key);
    if (!hash) {
      hash = new Map();
      hashes.set(key, hash);
    }
    return hash;
  }

  function setOf(key) {
    let set = sets.get(key);
    if (!set) {
      set = new Set();
      sets.set(key, set);
    }
    return set;
  }

  function listOf(key) {
    let list = lists.get(key);
    if (!list) {
      list = [];
      lists.set(key, list);
    }
    return list;
  }

  return {
    async command(args) {
      const op = String(args[0] || "").toUpperCase();
      const key = args[1];
      if (op === "SET") {
        const value = String(args[2]);
        let nx = false;
        let ex = null;
        for (let i = 3; i < args.length; i++) {
          const flag = String(args[i]).toUpperCase();
          if (flag === "NX") nx = true;
          else if (flag === "EX") ex = Number(args[++i]);
        }
        purge(key);
        if (nx && strings.has(key)) return null;
        strings.set(key, value);
        if (Number.isFinite(ex) && ex > 0) expiry.set(key, Date.now() + ex * 1000);
        else expiry.delete(key);
        return "OK";
      }
      if (op === "GET") {
        purge(key);
        return strings.has(key) ? strings.get(key) : null;
      }
      if (op === "DEL") {
        let removed = 0;
        for (let i = 1; i < args.length; i++) {
          const item = args[i];
          if (strings.delete(item)) removed += 1;
          expiry.delete(item);
          if (hashes.delete(item)) removed += 1;
          if (sets.delete(item)) removed += 1;
          if (lists.delete(item)) removed += 1;
        }
        return removed;
      }
      if (op === "HGET") {
        const hash = hashes.get(key);
        if (!hash || !hash.has(args[2])) return null;
        return hash.get(args[2]);
      }
      if (op === "HSET") {
        const hash = hashOf(key);
        const field = args[2];
        const fresh = hash.has(field) ? 0 : 1;
        hash.set(field, String(args[3]));
        return fresh;
      }
      if (op === "HGETALL") {
        const hash = hashes.get(key);
        if (!hash || hash.size === 0) return [];
        const flat = [];
        for (const [field, value] of hash) {
          flat.push(field, value);
        }
        return flat;
      }
      if (op === "HLEN") {
        const hash = hashes.get(key);
        return hash ? hash.size : 0;
      }
      if (op === "SADD") {
        const set = setOf(key);
        let added = 0;
        for (let i = 2; i < args.length; i++) {
          const member = String(args[i]);
          if (!set.has(member)) {
            set.add(member);
            added += 1;
          }
        }
        return added;
      }
      if (op === "SREM") {
        const set = sets.get(key);
        if (!set) return 0;
        let removed = 0;
        for (let i = 2; i < args.length; i++) {
          if (set.delete(String(args[i]))) removed += 1;
        }
        return removed;
      }
      if (op === "SISMEMBER") {
        const set = sets.get(key);
        return set && set.has(String(args[2])) ? 1 : 0;
      }
      if (op === "SMEMBERS") {
        const set = sets.get(key);
        return set ? [...set] : [];
      }
      if (op === "SCARD") {
        const set = sets.get(key);
        return set ? set.size : 0;
      }
      if (op === "RPUSH") {
        const list = listOf(key);
        for (let i = 2; i < args.length; i++) list.push(String(args[i]));
        return list.length;
      }
      if (op === "LRANGE") {
        const list = lists.get(key) || [];
        const length = list.length;
        let start = Number(args[2]);
        let stop = Number(args[3]);
        if (start < 0) start = length + start;
        if (stop < 0) stop = length + stop;
        if (start < 0) start = 0;
        if (stop >= length) stop = length - 1;
        if (start > stop || start >= length) return [];
        return list.slice(start, stop + 1);
      }
      if (op === "LLEN") {
        const list = lists.get(key);
        return list ? list.length : 0;
      }
      throw new Error("unknown_command");
    },
    async pipeline(commands) {
      const results = [];
      for (const command of commands) results.push(await this.command(command));
      return results;
    },
  };
}

function createUpstashRedis(url, token, fetchImpl) {
  const base = String(url).replace(/\/$/, "");
  const doFetch = fetchImpl || globalThis.fetch;
  async function post(path, payload) {
    let response;
    try {
      response = await doFetch(base + path, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
    } catch (error) {
      const wrapped = new Error("redis_network");
      wrapped.code = "redis";
      throw wrapped;
    }
    if (!response.ok) {
      const error = new Error("redis_http");
      error.code = "redis";
      throw error;
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      const wrapped = new Error("redis_json");
      wrapped.code = "redis";
      throw wrapped;
    }
    return data;
  }

  return {
    async command(args) {
      const data = await post("", args);
      if (data && typeof data === "object" && !Array.isArray(data) && data.error) {
        const error = new Error("redis_command");
        error.code = "redis";
        throw error;
      }
      return data ? data.result : null;
    },
    async pipeline(commands) {
      const data = await post("/pipeline", commands);
      if (!Array.isArray(data)) {
        const error = new Error("redis_pipeline");
        error.code = "redis";
        throw error;
      }
      return data.map((item) => {
        if (item && item.error) {
          const error = new Error("redis_command");
          error.code = "redis";
          throw error;
        }
        return item ? item.result : null;
      });
    },
  };
}

function firstEnv(env, names) {
  const source = env || {};
  for (let i = 0; i < names.length; i++) {
    const value = source[names[i]];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function redisFromEnv(env) {
  const url = firstEnv(env, ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL"]);
  const token = firstEnv(env, ["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN"]);
  if (!url && !token) {
    return {
      ok: false,
      error: "not_configured",
      message: "Evidența giveaway-ului nu este configurată. Lipsesc UPSTASH_REDIS_REST_URL sau KV_REST_API_URL, și UPSTASH_REDIS_REST_TOKEN sau KV_REST_API_TOKEN.",
    };
  }
  if (!url || !token) {
    const missing = !url
      ? "UPSTASH_REDIS_REST_URL sau KV_REST_API_URL"
      : "UPSTASH_REDIS_REST_TOKEN sau KV_REST_API_TOKEN";
    return {
      ok: false,
      error: "not_configured",
      message: "Evidența giveaway-ului nu este configurată. Lipsește " + missing + ".",
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return {
      ok: false,
      error: "not_configured",
      message: "UPSTASH_REDIS_REST_URL sau KV_REST_API_URL nu este un URL valid.",
    };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "not_configured",
      message: "UPSTASH_REDIS_REST_URL sau KV_REST_API_URL trebuie să folosească HTTPS.",
    };
  }
  return { ok: true, client: createUpstashRedis(url, token) };
}

module.exports = {
  createMemoryRedis,
  createUpstashRedis,
  redisFromEnv,
};
