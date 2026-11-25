(function () {
  const canvas = document.getElementById("gw-wheel");
  const note = document.getElementById("gw-wheel-note");
  const result = document.getElementById("gw-result");
  const alertEl = document.getElementById("gw-alert");
  const commitEl = document.getElementById("gw-commit");
  const snapshotEl = document.getElementById("gw-snapshot");
  const checkEl = document.getElementById("gw-check");
  const seedEl = document.getElementById("gw-seed");
  const colors = ["#121614", "#12343a", "#2a2412", "#3a2218"];
  let spun = false;

  function platformLabel(id) {
    if (id === "tiktok") return "TikTok";
    if (id === "youtube") return "YouTube";
    return id || "";
  }

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function showAlert(message) {
    if (!alertEl) return;
    alertEl.hidden = !message;
    alertEl.textContent = message || "";
  }

  function segmentsFrom(list, winnerKey) {
    if (!Array.isArray(list) || !list.length) return [];
    const index = list.findIndex((row) => row.key === winnerKey);
    if (index < 0) {
      return list.slice(0, 16).map((row) => decorate(row, false));
    }
    const max = 16;
    let start = 0;
    if (list.length > max) {
      start = Math.max(0, index - 7);
      if (start + max > list.length) start = list.length - max;
    }
    return list.slice(start, start + max).map((row) => decorate(row, row.key === winnerKey));
  }

  function decorate(row, winner) {
    return {
      handle: row.handle || row.displayName || "—",
      winner: winner,
    };
  }

  function paint(segments) {
    const ctx = canvas.getContext("2d");
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 12;
    ctx.clearRect(0, 0, size, size);
    const count = Math.max(segments.length, 1);
    const arc = (Math.PI * 2) / count;
    for (let i = 0; i < count; i++) {
      const start = -Math.PI / 2 + i * arc;
      const segment = segments[i];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, start + arc);
      ctx.closePath();
      ctx.fillStyle = segment && segment.winner ? "#ffd34f" : colors[i % colors.length];
      ctx.fill();
      ctx.strokeStyle = "#080a0b";
      ctx.lineWidth = 3;
      ctx.stroke();
      if (!segment) continue;
      if (count === 1) {
        ctx.fillStyle = segment.winner ? "#080a0b" : "#f6f3e9";
        ctx.font = "600 28px Barlow, Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(segment.handle).replace(/^@+/, "").slice(0, 16), cx, cy + 110);
        continue;
      }
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + arc / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = segment.winner ? "#080a0b" : "#f6f3e9";
      ctx.font = "600 28px Barlow, Arial, sans-serif";
      ctx.fillText(String(segment.handle).replace(/^@+/, "").slice(0, 16), radius - 28, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, 58, 0, Math.PI * 2);
    ctx.fillStyle = "#080a0b";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = "#ffd34f";
    ctx.stroke();
    ctx.fillStyle = "#ffd34f";
    ctx.font = "800 24px 'Barlow Condensed', Impact, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GTA 6", cx, cy);
  }

  function landingAngle(index, count) {
    const arc = (Math.PI * 2) / Math.max(count, 1);
    const mid = -Math.PI / 2 + index * arc + arc / 2;
    let theta = -Math.PI / 2 - mid;
    const turns = 6 * Math.PI * 2;
    while (theta < turns) theta += Math.PI * 2;
    return theta;
  }

  function spinTo(index, count) {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const theta = landingAngle(index, count);
    if (reduce || spun) {
      canvas.style.transition = "none";
      canvas.style.transform = "rotate(" + theta + "rad)";
      spun = true;
      return;
    }
    canvas.style.transition = "none";
    canvas.style.transform = "rotate(0rad)";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        canvas.style.transition = "transform 6.5s cubic-bezier(0.12, 0.7, 0.08, 1)";
        canvas.style.transform = "rotate(" + theta + "rad)";
        spun = true;
      });
    });
  }

  function addRow(term, value) {
    const row = document.createElement("div");
    row.className = "spec";
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    row.append(dt, dd);
    result.append(row);
  }

  function renderResult(data, segments) {
    result.replaceChildren();
    const winner = data && data.result && data.result.winner;
    if (!winner) {
      addRow("Câștigător", "Încă nu este extras.");
      paint(segments.length ? segments : [{ handle: "24 DEC", winner: false }]);
      return;
    }
    const winnerIndex = Math.max(0, segments.findIndex((segment) => segment.winner));
    paint(segments);
    spinTo(winnerIndex, segments.length);
    addRow("Câștigător", "@" + winner.handle + " · " + platformLabel(winner.platform) + " · " + winner.entries + (winner.entries === 1 ? " intrare" : " intrări"));
    (data.result.reserves || []).forEach((reserve, index) => {
      addRow("Rezerva " + (index + 1), "@" + reserve.handle + " · " + platformLabel(reserve.platform));
    });
    setText(note, "Animația este ilustrativă. Numele de sub roată este rezultatul oficial.");
  }

  async function verify(data) {
    const math = window.GiveawayDraw;
    const list = data && data.snapshot && data.snapshot.list;
    if (!math || !list) {
      setText(checkEl, "Se verifică după ce există lista și seed-ul.");
      return;
    }
    try {
      const canonical = math.canonicalJson(list);
      const hash = await math.sha256Hex(canonical);
      if (hash !== data.snapshot.hash) {
        setText(checkEl, "Hash-ul listei nu se potrivește cu lista publică.");
        return;
      }
      if (!data.result || !data.result.seed) {
        setText(checkEl, "Lista înghețată se potrivește cu hash-ul public. Seed-ul încă nu este arătat.");
        return;
      }
      const reserveCount = Number.isInteger(data.result.reserveCount) ? data.result.reserveCount : math.CAMPAIGN.reserves;
      const drawn = await math.drawWinners(list, data.result.seed, hash, reserveCount);
      if (!drawn.picks[0] || drawn.picks[0].key !== data.result.winner.key) {
        setText(checkEl, "Recalcularea din browser nu se potrivește cu rezultatul publicat.");
        return;
      }
      setText(checkEl, "Verificat în acest browser: același câștigător.");
    } catch (error) {
      setText(checkEl, "Verificarea locală nu a putut fi făcută. Rezultatul de pe server rămâne cel oficial.");
    }
  }

  async function load() {
    try {
      const response = await fetch("/api/giveaway/draw?full=1", { headers: { Accept: "application/json" }, cache: "no-store" });
      const data = await response.json();
      if (response.status === 503 || data.configured === false) {
        showAlert("Evidența giveaway-ului nu este configurată încă. Pagina poate fi citită, dar rezultatul apare după configurare și după extragerea live.");
        setText(commitEl, "Neconfigurat");
        setText(snapshotEl, "Neconfigurat");
        paint([{ handle: "24 DEC", winner: false }]);
        result.replaceChildren();
        addRow("Câștigător", "Neconfigurat");
        return;
      }
      showAlert("");
      setText(commitEl, data.commit && data.commit.hash ? data.commit.hash : "Încă nu a fost publicat.");
      setText(snapshotEl, data.snapshot && data.snapshot.hash ? data.snapshot.hash : "Lista nu este înghețată.");
      setText(seedEl, data.result && data.result.seed ? data.result.seed : "Ascuns până la extragere.");
      const winnerKey = data.result && data.result.winner ? data.result.winner.key : "";
      const segments = segmentsFrom(data.snapshot && data.snapshot.list, winnerKey);
      renderResult(data, segments);
      verify(data);
    } catch (error) {
      showAlert("Extragerea nu poate fi citită acum. Reîncarcă pagina.");
      paint([{ handle: "24 DEC", winner: false }]);
    }
  }

  function paintNames(list) {
    const winner = list.find((row) => row.winner);
    const plain = list.map((row) => ({ handle: row.handle, winner: false }));
    paint(plain);
    return winner ? list.findIndex((row) => row.winner) : 0;
  }

  function finishDemo(pack, segments) {
    const marked = segments.map((segment) => ({
      handle: segment.handle,
      winner: segment.handle === pack.winner.handle,
    }));
    paint(marked);
    result.replaceChildren();
    addRow("Câștigător", "@" + pack.winner.handle + " · " + platformLabel(pack.winner.platform) + " · " + pack.winner.weight + (pack.winner.weight === 1 ? " intrare" : " intrări"));
    pack.reservePicks.forEach((reserve, index) => {
      addRow("Rezerva " + (index + 1), "@" + reserve.handle + " · " + platformLabel(reserve.platform) + " · " + reserve.weight + " intrări");
    });
    setText(seedEl, pack.seed);
    setText(note, "Simulare încheiată. Seed-ul de test este public. Verificarea de mai jos recalculează același câștigător.");
    verify({
      snapshot: { list: pack.list, hash: pack.snapshotHash },
      result: {
        seed: pack.seed,
        reserveCount: pack.reserves,
        winner: { key: pack.winner.key },
      },
    });
  }

  async function runDemo() {
    const pack = await window.GiveawayDemo.build(window.GiveawayDraw);
    showAlert(pack.banner);
    const people = document.getElementById("gw-demo-people");
    const entries = document.getElementById("gw-demo-entries");
    const totals = document.getElementById("gw-demo-totals");
    const actions = document.getElementById("gw-demo-actions");
    if (people) people.textContent = String(pack.participants);
    if (entries) entries.textContent = String(pack.entries);
    if (totals) totals.hidden = false;
    if (actions) actions.hidden = false;
    setText(commitEl, pack.commitHash);
    setText(snapshotEl, pack.snapshotHash);
    setText(seedEl, "Ascuns până la extragere.");
    setText(note, "Lista de test este înghețată. Hash-ul de angajament este public. Apasă butonul ca să vezi roata, câștigătorul, cele 2 rezerve și seed-ul.");
    result.replaceChildren();
    addRow("Câștigător", "Încă nu este extras.");
    const back = document.querySelector('a[href="/giveaway/"]');
    if (back) back.href = "/giveaway/?demo=1";
    const segments = segmentsFrom(pack.list, pack.winner.key).map((segment) => ({
      handle: segment.handle,
      winner: segment.handle === pack.winner.handle,
    }));
    const winnerIndex = paintNames(segments);
    const button = document.getElementById("gw-demo-start");
    if (!button) return;
      button.addEventListener("click", () => {
      if (button.disabled) return;
      button.disabled = true;
      setText(note, "Roata se învârte. Biletele sunt deja numărate: cine are mai multe intrări are mai multe șanse.");
      const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      spinTo(winnerIndex, segments.length);
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        finishDemo(pack, segments);
      };
      if (reduce) {
        done();
        return;
      }
      canvas.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 8000);
    });
  }

  function start() {
    paint([{ handle: "24 DEC", winner: false }]);
    if (window.GiveawayDemo && window.GiveawayDemo.isDemo(window.location.search)) {
      runDemo();
      return;
    }
    load();
    setInterval(() => {
      if (!document.hidden && !spun) load();
    }, 15000);
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else start();
})();
