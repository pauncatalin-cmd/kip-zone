// Public GTA 6 draw math. Loaded by the site and required by the API.
// Same inputs (seed, frozen snapshot) always produce the same winners.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GiveawayDraw = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // 1 Dec 2026 00:00 and 24 Dec 2026 20:00, Europe/Bucharest (EET, UTC+2).
  const CAMPAIGN = {
    open: "2026-12-01T00:00:00+02:00",
    close: "2026-12-24T20:00:00+02:00",
    timeZone: "Europe/Bucharest",
    command: "!gta6",
    reserves: 5,
    minAccountAgeMs: 7 * 24 * 60 * 60 * 1000,
    skewMs: 10 * 60 * 1000,
  };

  const RANGE = 2 ** 48;

  function hex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  async function sha256Bytes(text) {
    const encoded = new TextEncoder().encode(String(text));
    const bytes = new Uint8Array(encoded);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return new Uint8Array(digest);
  }

  async function sha256Hex(text) {
    return hex(await sha256Bytes(text));
  }

  function isExactCommand(value) {
    if (typeof value !== "string") return false;
    const cleaned = value.replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase();
    return cleaned === CAMPAIGN.command;
  }

  async function participantKey(platform, userId) {
    return sha256Hex(String(platform) + "\0" + String(userId));
  }

  function canonicalJson(list) {
    return JSON.stringify(list.map((row) => ({
      key: row.key,
      platform: row.platform,
      handle: row.handle,
      displayName: row.displayName,
      weight: row.weight,
      dates: row.dates,
    })));
  }

  function prngInput(seed, snapshotHash, counter) {
    return JSON.stringify([String(seed), String(snapshotHash), counter]);
  }

  async function uint48(seed, snapshotHash, counter) {
    const bytes = await sha256Bytes(prngInput(seed, snapshotHash, counter));
    let value = 0;
    for (let i = 0; i < 6; i++) value = value * 256 + bytes[i];
    return value;
  }

  async function uniformBelow(seed, snapshotHash, n, counter) {
    if (!Number.isInteger(n) || n <= 0) throw new Error("bad_range");
    if (n > RANGE) throw new Error("bad_range");
    const limit = RANGE - (RANGE % n);
    let next = counter;
    for (;;) {
      const value = await uint48(seed, snapshotHash, next);
      next += 1;
      if (value < limit) return { value: value % n, counter: next };
    }
  }

  function indexForTicket(pool, ticket) {
    let left = ticket;
    for (let i = 0; i < pool.length; i++) {
      if (left < pool[i].weight) return i;
      left -= pool[i].weight;
    }
    return pool.length - 1;
  }

  async function drawWinners(participants, seed, snapshotHash, reserveCount) {
    const pool = participants
      .filter((row) => Number.isInteger(row.weight) && row.weight > 0)
      .map((row) => ({
        key: row.key,
        platform: row.platform,
        handle: row.handle,
        displayName: row.displayName,
        weight: row.weight,
        dates: row.dates.slice(),
      }));
    const picks = [];
    const need = 1 + (Number.isInteger(reserveCount) ? reserveCount : CAMPAIGN.reserves);
    let counter = 0;
    while (pool.length && picks.length < need) {
      const total = pool.reduce((sum, row) => sum + row.weight, 0);
      const roll = await uniformBelow(seed, snapshotHash, total, counter);
      counter = roll.counter;
      const index = indexForTicket(pool, roll.value);
      picks.push(pool[index]);
      pool.splice(index, 1);
    }
    return { picks, counter };
  }

  return {
    CAMPAIGN,
    RANGE,
    sha256Hex,
    isExactCommand,
    participantKey,
    canonicalJson,
    prngInput,
    uint48,
    uniformBelow,
    indexForTicket,
    drawWinners,
  };
});
