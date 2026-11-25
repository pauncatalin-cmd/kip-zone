// Client-only rehearsal. Loaded only to build fake data in the browser.
// It never calls the network and never writes to Redis.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.GiveawayDemo = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const BANNER = "SIMULARE – date de test";
  const SEED = "demo-test-seed-kipzone-gta6-nu-este-real";
  const RESERVES = 2;
  const ROSTER = [
    ["tiktok", "test_mira", 18],
    ["tiktok", "test_andrei", 7],
    ["tiktok", "test_lara", 12],
    ["tiktok", "test_codrin", 3],
    ["tiktok", "test_ioana", 15],
    ["tiktok", "test_radu", 1],
    ["tiktok", "test_daria", 9],
    ["tiktok", "test_vlad", 20],
    ["tiktok", "test_elena", 4],
    ["tiktok", "test_matei", 6],
    ["tiktok", "test_sofia", 11],
    ["tiktok", "test_paul", 2],
    ["tiktok", "test_iris", 8],
    ["tiktok", "test_natan", 14],
    ["tiktok", "test_bianca", 5],
    ["youtube", "test_kristi", 16],
    ["youtube", "test_omar", 10],
    ["youtube", "test_teona", 13],
    ["youtube", "test_florin", 1],
    ["youtube", "test_alina", 19],
    ["youtube", "test_george", 8],
    ["youtube", "test_nora", 3],
    ["youtube", "test_raul", 17],
    ["youtube", "test_ema", 6],
    ["youtube", "test_tavi", 2],
    ["youtube", "test_lia", 9],
    ["youtube", "test_cosmin", 4],
    ["youtube", "test_sara", 12],
    ["youtube", "test_ionut", 7],
    ["youtube", "test_rebeca", 15],
  ];

  function paramsFrom(search) {
    const query = search == null ? "" : String(search);
    return new URLSearchParams(query.charAt(0) === "?" ? query.slice(1) : query);
  }

  function isDemo(search) {
    return paramsFrom(search).get("demo") === "1";
  }

  function demoCount(search) {
    if (!isDemo(search)) return 0;
    const raw = paramsFrom(search).get("n");
    if (raw == null || raw === "") return 0;
    const count = Number(raw);
    if (!Number.isInteger(count) || count < 2) return 0;
    return Math.min(count, 5000);
  }

  function demoSeed(search) {
    if (!isDemo(search)) return "";
    const raw = paramsFrom(search).get("seed");
    return raw ? raw.trim() : "";
  }

  function demoQuery(search) {
    const params = paramsFrom(search);
    const out = new URLSearchParams();
    out.set("demo", "1");
    if (params.get("n")) out.set("n", params.get("n"));
    if (params.get("seed")) out.set("seed", params.get("seed"));
    return out.toString();
  }

  function randomSeed() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
    return "demo-" + hex;
  }

  function generatedRoster(count) {
    const rows = [];
    for (let index = 0; index < count; index++) {
      rows.push([
        index % 2 === 0 ? "tiktok" : "youtube",
        "test_" + String(index + 1).padStart(4, "0"),
        (index * 17 + 3) % 20 + 1,
      ]);
    }
    return rows;
  }

  function label(handle) {
    const bare = String(handle).replace(/^test_/, "");
    return "TEST " + bare.charAt(0).toUpperCase() + bare.slice(1);
  }

  async function prepare(draw, count) {
    const rows = count > 0 ? generatedRoster(count) : ROSTER;
    const list = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const platform = row[0];
      const handle = row[1];
      const weight = row[2];
      const day = String((index % 18) + 2).padStart(2, "0");
      list.push({
        key: await draw.participantKey(platform, "demo-test-" + platform + "-" + handle),
        platform: platform,
        handle: handle,
        displayName: label(handle),
        weight: weight,
        dates: ["2026-12-" + day],
      });
    }
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const canonical = draw.canonicalJson(list);
    return {
      banner: BANNER,
      reserves: RESERVES,
      list: list,
      snapshotHash: await draw.sha256Hex(canonical),
      participants: list.length,
      entries: list.reduce((sum, row) => sum + row.weight, 0),
      lives: new Set(list.map((row) => row.dates[0])).size,
    };
  }

  async function drawWith(draw, prepared, seed) {
    const used = String(seed || "");
    const commitHash = await draw.sha256Hex(used);
    const drawn = await draw.drawWinners(prepared.list, used, prepared.snapshotHash, RESERVES);
    return {
      seed: used,
      commitHash: commitHash,
      winner: drawn.picks[0],
      reservePicks: drawn.picks.slice(1),
    };
  }

  async function build(draw, count, seed) {
    const prepared = await prepare(draw, count || 0);
    const result = await drawWith(draw, prepared, seed ? String(seed) : SEED);
    return {
      banner: prepared.banner,
      seed: result.seed,
      reserves: prepared.reserves,
      list: prepared.list,
      snapshotHash: prepared.snapshotHash,
      commitHash: result.commitHash,
      participants: prepared.participants,
      entries: prepared.entries,
      lives: prepared.lives,
      winner: result.winner,
      reservePicks: result.reservePicks,
    };
  }

  return {
    BANNER: BANNER,
    SEED: SEED,
    RESERVES: RESERVES,
    ROSTER: ROSTER,
    isDemo: isDemo,
    demoCount: demoCount,
    demoSeed: demoSeed,
    demoQuery: demoQuery,
    randomSeed: randomSeed,
    generatedRoster: generatedRoster,
    prepare: prepare,
    drawWith: drawWith,
    build: build,
  };
});
