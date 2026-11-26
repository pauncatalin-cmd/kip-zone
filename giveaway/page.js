(function () {
  const campaign = window.GiveawayDraw && window.GiveawayDraw.CAMPAIGN;
  const REFRESH_MS = 15000;
  const alertEl = document.getElementById("gw-alert");
  const phaseEl = document.getElementById("gw-phase");
  const commitEl = document.getElementById("gw-commit");
  const searchStatus = document.getElementById("gw-search-status");
  const searchResults = document.getElementById("gw-search-results");
  const board = document.getElementById("gw-board");
  let activeQuery = "";
  let configured = true;

  function formatNumber(value) {
    if (value == null || Number.isNaN(Number(value))) return "–";
    return new Intl.NumberFormat("ro-RO").format(value);
  }

  function entryLabel(count) {
    const text = formatNumber(count);
    return text + (count === 1 ? " intrare" : " intrări");
  }

  function platformLabel(id) {
    if (id === "tiktok") return "TikTok";
    if (id === "youtube") return "YouTube";
    return id || "";
  }

  function formatDate(iso) {
    const parts = String(iso || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !part)) return iso || "";
    return new Intl.DateTimeFormat("ro-RO", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])));
  }

  function showAlert(message) {
    if (!alertEl) return;
    if (!message) {
      alertEl.hidden = true;
      alertEl.textContent = "";
      return;
    }
    alertEl.hidden = false;
    alertEl.textContent = message;
  }

  async function readJson(url) {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }
    return { response, data };
  }

  function setTotal(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = formatNumber(value);
  }

  function renderPhase(stats) {
    if (!phaseEl) return;
    if (!stats || stats.configured === false) {
      phaseEl.textContent = "Numărătoarea nu e pornită încă.";
      return;
    }
    if (stats.revealed) {
      phaseEl.textContent = "S-a tras. Rezultatul e pe pagina extragerii.";
      return;
    }
    if (stats.frozen) {
      phaseEl.textContent = "Gata cu intrările. Urmează extragerea.";
      return;
    }
    if (stats.open) {
      phaseEl.textContent = "Poți intra. Scrie !gta6 în chat, o dată pe live.";
      return;
    }
    const openAt = stats.window && Date.parse(stats.window.open);
    if (openAt && Date.now() < openAt) {
      phaseEl.textContent = "Intrările încep pe 26 noiembrie 2026, la miezul nopții, ora Bucureștiului.";
      return;
    }
    phaseEl.textContent = "Intrările sunt închise.";
  }

  function renderBoard(payload) {
    if (!board) return;
    board.replaceChildren();
    const list = document.createElement("div");
    list.className = "specs";
    const leaders = payload && Array.isArray(payload.leaders) ? payload.leaders : [];
    if (!configured) {
      const row = document.createElement("div");
      row.className = "spec";
      const term = document.createElement("dt");
      term.textContent = "Clasament";
      const detail = document.createElement("dd");
      detail.textContent = "Încă nu e pornit";
      row.append(term, detail);
      list.append(row);
      board.append(list);
      return;
    }
    if (!leaders.length) {
      const row = document.createElement("div");
      row.className = "spec";
      const term = document.createElement("dt");
      term.textContent = "Clasament";
      const detail = document.createElement("dd");
      detail.textContent = "Încă nu există intrări.";
      row.append(term, detail);
      list.append(row);
      board.append(list);
      return;
    }
    leaders.forEach((leader, index) => {
      const row = document.createElement("div");
      row.className = "spec";
      const term = document.createElement("dt");
      term.textContent = String(index + 1).padStart(2, "0") + " · " + platformLabel(leader.platform);
      const detail = document.createElement("dd");
      const name = document.createElement("b");
      name.textContent = "@" + String(leader.handle || "").replace(/^@+/, "");
      detail.append(name);
      const nickname = String(leader.displayName || "");
      const handle = String(leader.handle || "");
      if (nickname && nickname.toLowerCase() !== handle.toLowerCase()) {
        detail.append(document.createTextNode(" · " + nickname));
      }
      detail.append(document.createTextNode(" · " + entryLabel(leader.entries)));
      row.append(term, detail);
      list.append(row);
    });
    board.append(list);
  }

  function renderSearch(payload, message) {
    if (searchStatus) searchStatus.textContent = message || "";
    if (!searchResults) return;
    searchResults.replaceChildren();
    const results = payload && Array.isArray(payload.results) ? payload.results : [];
    if (!results.length) return;
    const list = document.createElement("div");
    list.className = "specs";
    results.forEach((hit) => {
      const row = document.createElement("div");
      row.className = "spec";
      const term = document.createElement("dt");
      term.textContent = platformLabel(hit.platform);
      const detail = document.createElement("dd");
      const name = document.createElement("b");
      name.textContent = "@" + String(hit.handle || "").replace(/^@+/, "");
      detail.append(name, document.createTextNode(" · " + entryLabel(hit.entries)));
      const dates = Array.isArray(hit.dates) ? hit.dates.map(formatDate).join(", ") : "";
      if (dates) detail.append(document.createTextNode(" · " + dates));
      row.append(term, detail);
      list.append(row);
    });
    searchResults.append(list);
  }

  async function refreshSearch() {
    if (!activeQuery) return;
    try {
      const { response, data } = await readJson("/api/giveaway/search?q=" + encodeURIComponent(activeQuery));
      if (response.status === 503 || (data && data.configured === false)) {
        renderSearch(null, "Căutarea nu e pornită încă.");
        return;
      }
      if (!response.ok) {
        renderSearch(null, (data && data.message) || "Căutarea nu a mers. Încearcă din nou.");
        return;
      }
      const count = data.results ? data.results.length : 0;
      renderSearch(data, count ? "" : "Nicio intrare găsită pentru această căutare.");
    } catch (error) {
      renderSearch(null, "Căutarea nu a mers. Încearcă din nou.");
    }
  }

  async function refresh() {
    if (!configured && alertEl && !alertEl.hidden) {
      /* Keep trying so the page recovers when Redis is connected. */
    }
    try {
      const [statsResult, boardResult, drawResult] = await Promise.all([
        readJson("/api/giveaway/stats"),
        readJson("/api/giveaway/leaderboard"),
        readJson("/api/giveaway/draw"),
      ]);
      const missing = [statsResult, boardResult, drawResult].some((item) => {
        return item.response.status === 503 || (item.data && item.data.configured === false);
      });
      configured = !missing;
      if (missing) {
        showAlert("Numărătoarea nu e pornită încă. Regulile de mai jos rămân valabile.");
        setTotal("gw-participants", null);
        setTotal("gw-entries", null);
        setTotal("gw-lives", null);
        renderPhase({ configured: false });
        renderBoard({ leaders: [] });
        if (commitEl) commitEl.textContent = "Neconfigurat";
      } else {
        showAlert("");
        const stats = statsResult.data || {};
        const leaders = boardResult.data || {};
        if (!statsResult.response.ok || !boardResult.response.ok) {
          showAlert("Nu pot citi lista acum. Mai încerc singur.");
        }
        setTotal("gw-participants", leaders.participants);
        setTotal("gw-entries", leaders.entries);
        setTotal("gw-lives", stats.lives);
        renderPhase(stats);
        renderBoard(leaders);
        const hash = (drawResult.data && drawResult.data.commit && drawResult.data.commit.hash) || stats.commitHash;
        if (commitEl) commitEl.textContent = hash || "Încă nu a fost publicat.";
      }
    } catch (error) {
      showAlert("Nu pot citi lista acum. Mai încerc singur.");
    }
    if (activeQuery) refreshSearch();
  }

  function tick() {
    if (!campaign) return;
    const target = Date.parse(campaign.close);
    const note = document.getElementById("countdown-note");
    const units = {
      days: document.querySelector("[data-unit='days']"),
      hours: document.querySelector("[data-unit='hours']"),
      minutes: document.querySelector("[data-unit='minutes']"),
      seconds: document.querySelector("[data-unit='seconds']"),
    };
    const diff = target - Date.now();
    if (diff <= 0) {
      Object.values(units).forEach((el) => {
        if (el) el.textContent = "0";
      });
      if (note) note.textContent = "A venit ora extragerii: 24 decembrie 2026, 20:00, Europa/București.";
      return;
    }
    const total = Math.floor(diff / 1000);
    const parts = {
      days: Math.floor(total / 86400),
      hours: Math.floor((total % 86400) / 3600),
      minutes: Math.floor((total % 3600) / 60),
      seconds: total % 60,
    };
    Object.keys(parts).forEach((key) => {
      if (units[key]) units[key].textContent = String(parts[key]).padStart(2, "0");
    });
  }

  function localSearch(pack, query) {
    const needle = query.toLowerCase();
    const results = pack.list
      .filter((row) => {
        return row.handle.toLowerCase().includes(needle) || row.displayName.toLowerCase().includes(needle);
      })
      .map((row) => ({
        platform: row.platform,
        handle: row.handle,
        displayName: row.displayName,
        entries: row.weight,
        dates: row.dates,
      }))
      .sort((a, b) => b.entries - a.entries || a.handle.localeCompare(b.handle, "ro"));
    return results.slice(0, 20);
  }

  async function runDemo() {
    const count = window.GiveawayDemo.demoCount(window.location.search);
    const pinned = window.GiveawayDemo.demoSeed(window.location.search);
    const pack = await window.GiveawayDemo.prepare(window.GiveawayDraw, count);
    showAlert(pack.banner);
    configured = true;
    setTotal("gw-participants", pack.participants);
    setTotal("gw-entries", pack.entries);
    setTotal("gw-lives", pack.lives);
    if (phaseEl) {
      phaseEl.textContent = pinned
        ? "Simulare. Lista e de test. Adresa reia același rezultat."
        : "Simulare. Lista e de test. La fiecare pornire iese alt câștigător.";
    }
    renderBoard({
      leaders: pack.list
        .map((row) => ({ platform: row.platform, handle: row.handle, displayName: row.displayName, entries: row.weight }))
        .sort((a, b) => b.entries - a.entries || a.handle.localeCompare(b.handle, "ro"))
        .slice(0, 20),
    });
    if (commitEl) commitEl.textContent = pinned ? await window.GiveawayDraw.sha256Hex(pinned) : "Apare la pornirea simulării.";
    document.querySelectorAll('a[href="/giveaway/extragere/"]').forEach((link) => {
      link.href = "/giveaway/extragere/?" + window.GiveawayDemo.demoQuery(window.location.search);
    });
    const form = document.getElementById("gw-search");
    if (form) {
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const input = document.getElementById("gw-q");
        const query = input ? input.value.trim().replace(/^@+/, "") : "";
        if (query.length < 2) {
          renderSearch(null, "Scrie cel puțin 2 caractere.");
          return;
        }
        const results = localSearch(pack, query);
        renderSearch({ results: results }, results.length ? "" : "Nicio intrare de test pentru această căutare.");
      });
    }
  }

  const demo = window.GiveawayDemo && window.GiveawayDemo.isDemo(window.location.search);
  tick();
  setInterval(tick, 1000);
  if (demo) {
    runDemo();
    return;
  }

  const form = document.getElementById("gw-search");
  if (form) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("gw-q");
      activeQuery = input ? input.value.trim().replace(/^@+/, "") : "";
      if (activeQuery.length < 2) {
        renderSearch(null, "Scrie cel puțin 2 caractere.");
        return;
      }
      refreshSearch();
    });
  }

  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
})();
