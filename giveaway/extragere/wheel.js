(function () {
  const canvas = document.getElementById("gw-wheel");
  const note = document.getElementById("gw-wheel-note");
  const result = document.getElementById("gw-result");
  const alertEl = document.getElementById("gw-alert");
  const commitEl = document.getElementById("gw-commit");
  const snapshotEl = document.getElementById("gw-snapshot");
  const checkEl = document.getElementById("gw-check");
  const seedEl = document.getElementById("gw-seed");
  const reel = document.getElementById("gw-reel");
  const colors = ["#121614", "#12343a", "#2a2412", "#3a2218"];
  let spinToken = 0;

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

  function showReel(text, locked) {
    if (!reel) return;
    reel.hidden = !text;
    reel.textContent = text || "";
    reel.classList.toggle("is-winner", Boolean(locked));
  }

  function fitCanvas() {
    const css = Math.max(canvas.clientWidth || 640, 280);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(css * dpr);
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = px;
      canvas.height = px;
    }
    return px;
  }

  function paint(slices, highlight) {
    const size = fitCanvas();
    const ctx = canvas.getContext("2d");
    const cx = size / 2;
    const cy = size / 2;
    const radius = size / 2 - 8;
    ctx.clearRect(0, 0, size, size);
    const list = slices && slices.length ? slices : [{ handle: "24 DEC", start: 0, end: Math.PI * 2, mid: Math.PI, arc: Math.PI * 2, label: true, winner: false, weight: 1 }];
    for (let index = 0; index < list.length; index++) {
      const slice = list[index];
      const start = -Math.PI / 2 + slice.start;
      const end = -Math.PI / 2 + slice.end;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = highlight && slice.winner ? "#ffd34f" : colors[index % colors.length];
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = "#ffd34f55";
    ctx.lineWidth = Math.max(2, size / 220);
    ctx.stroke();
    for (let index = 0; index < list.length; index++) {
      const slice = list[index];
      const wideEnough = slice.label || (highlight && slice.winner && slice.arc >= 0.22);
      if (highlight && slice.winner && slice.arc < 0.08) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2 + slice.mid);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(radius, 0);
        ctx.strokeStyle = "#ffd34f";
        ctx.lineWidth = Math.max(3, size / 140);
        ctx.stroke();
        ctx.restore();
      }
      if (!wideEnough) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 2 + slice.mid);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = highlight && slice.winner ? "#080a0b" : "#f6f3e9";
      ctx.font = "600 " + Math.round(size / 42) + "px Barlow, Arial, sans-serif";
      ctx.fillText(String(slice.handle).replace(/^@+/, "").slice(0, 14), radius - size / 18, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = "#080a0b";
    ctx.fill();
    ctx.lineWidth = Math.max(3, size / 160);
    ctx.strokeStyle = "#ffd34f";
    ctx.stroke();
    ctx.fillStyle = "#ffd34f";
    ctx.font = "800 " + Math.round(size / 26) + "px 'Barlow Condensed', Impact, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("GTA 6", cx, cy);
  }

  function spinSlices(slices, winnerKey, onFrame, onDone) {
    const wheel = window.GiveawayWheel;
    const winner = slices.find((slice) => slice.key === winnerKey) || slices[0];
    const token = ++spinToken;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    canvas.style.transition = "none";
    canvas.style.willChange = "transform";
    if (!winner || reduce) {
      if (winner) canvas.style.transform = "rotate(" + wheel.landingRotation(winner.mid) + "rad)";
      if (winner) onFrame(winner);
      onDone();
      return;
    }
    const theta = wheel.landingRotation(winner.mid);
    const duration = 6500;
    const started = performance.now();
    canvas.style.transform = "rotate(0rad)";
    function frame(now) {
      if (token !== spinToken) return;
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      const angle = theta * eased;
      canvas.style.transform = "rotate(" + angle + "rad)";
      const under = wheel.sliceAt(slices, wheel.pointerFromRotation(angle));
      if (under) onFrame(under);
      if (t < 1) requestAnimationFrame(frame);
      else onDone();
    }
    requestAnimationFrame(frame);
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

  function personLine(person, entries) {
    const count = entries == null ? person.entries || person.weight : entries;
    return "@" + person.handle + " · " + platformLabel(person.platform) + (count ? " · " + count + (count === 1 ? " intrare" : " intrări") : "");
  }

  function renderResult(data) {
    result.replaceChildren();
    const list = data && data.snapshot && data.snapshot.list;
    const winner = data && data.result && data.result.winner;
    if (!winner) {
      addRow("Câștigător", "Încă nu este extras.");
      paint(window.GiveawayWheel.layoutSlices(list || [], ""), false);
      showReel("", false);
      return;
    }
    const slices = window.GiveawayWheel.layoutSlices(list || [], winner.key);
    paint(slices, false);
    showReel("", false);
    spinSlices(slices, winner.key, (under) => {
      showReel("@" + under.handle, false);
    }, () => {
      paint(slices, true);
      showReel("@" + winner.handle, true);
    });
    addRow("Câștigător", personLine(winner, winner.entries));
    (data.result.reserves || []).forEach((reserve, index) => {
      addRow("Rezerva " + (index + 1), personLine(reserve, reserve.entries));
    });
    setText(note, "Animația este ilustrativă. Numele de sub roată este rezultatul oficial. Pe roată se scriu doar feliile destul de late.");
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
        paint([], false);
        result.replaceChildren();
        addRow("Câștigător", "Neconfigurat");
        return;
      }
      showAlert("");
      setText(commitEl, data.commit && data.commit.hash ? data.commit.hash : "Încă nu a fost publicat.");
      setText(snapshotEl, data.snapshot && data.snapshot.hash ? data.snapshot.hash : "Lista nu este înghețată.");
      setText(seedEl, data.result && data.result.seed ? data.result.seed : "Ascuns până la extragere.");
      renderResult(data);
      verify(data);
    } catch (error) {
      showAlert("Extragerea nu poate fi citită acum. Reîncarcă pagina.");
      paint([], false);
    }
  }

  function finishDemo(pack, drawn, slices) {
    paint(slices, true);
    showReel("@" + drawn.winner.handle, true);
    result.replaceChildren();
    addRow("Câștigător", personLine(drawn.winner, drawn.winner.weight));
    drawn.reservePicks.forEach((reserve, index) => {
      addRow("Rezerva " + (index + 1), personLine(reserve, reserve.weight));
    });
    setText(note, "Simulare încheiată. Seed-ul de mai jos este cel folosit acum. Verificarea recalculează același câștigător.");
    verify({
      snapshot: { list: pack.list, hash: pack.snapshotHash },
      result: {
        seed: drawn.seed,
        reserveCount: pack.reserves,
        winner: { key: drawn.winner.key },
      },
    });
  }

  async function runDemo() {
    const demo = window.GiveawayDemo;
    const count = demo.demoCount(window.location.search);
    const pinned = demo.demoSeed(window.location.search);
    const pack = await demo.prepare(window.GiveawayDraw, count);
    showAlert(pack.banner);
    const people = document.getElementById("gw-demo-people");
    const entries = document.getElementById("gw-demo-entries");
    const totals = document.getElementById("gw-demo-totals");
    const actions = document.getElementById("gw-demo-actions");
    if (people) people.textContent = String(pack.participants);
    if (entries) entries.textContent = String(pack.entries);
    if (totals) totals.hidden = false;
    if (actions) actions.hidden = false;
    setText(commitEl, pinned ? await window.GiveawayDraw.sha256Hex(pinned) : "Se calculează la fiecare pornire.");
    setText(snapshotEl, pack.snapshotHash);
    setText(seedEl, pinned ? pinned : "Un seed nou la fiecare pornire.");
    setText(note, pack.participants > 40
      ? "Lista de test este înghețată (" + pack.participants + " conturi). Feliile sunt proporționale cu intrările. Numele se scriu pe roată doar dacă încap; altfel curg sub săgeată."
      : "Lista de test este înghețată. Fiecare pornire folosește un seed nou, deci alt câștigător.");
    if (pinned) setText(note, "Seed-ul este fixat în adresă, ca să poți relua același rezultat. " + (note.textContent || ""));
    result.replaceChildren();
    addRow("Câștigător", "Încă nu este extras.");
    const query = demo.demoQuery(window.location.search);
    const back = document.querySelector('a.back[href="/giveaway/"], a.back[href^="/giveaway/?"]');
    if (back) back.href = "/giveaway/?" + query;
    const slices = window.GiveawayWheel.layoutSlices(pack.list, "");
    paint(slices, false);
    showReel("", false);
    const button = document.getElementById("gw-demo-start");
    if (!button) return;
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const seed = pinned || demo.randomSeed();
      const drawn = await demo.drawWith(window.GiveawayDraw, pack, seed);
      const marked = window.GiveawayWheel.layoutSlices(pack.list, drawn.winner.key);
      setText(commitEl, drawn.commitHash);
      setText(seedEl, drawn.seed);
      setText(note, "Roata se învârte cu seed-ul de mai sus. Cine are mai multe intrări are o felie mai mare.");
      paint(marked, false);
      showReel("@" + marked[0].handle, false);
      spinSlices(marked, drawn.winner.key, (under) => {
        showReel("@" + under.handle, false);
      }, () => {
        finishDemo(pack, drawn, marked);
        button.disabled = false;
        button.textContent = pinned ? "Repetă seed-ul" : "Pornește din nou";
      });
    });
  }

  function start() {
    paint([], false);
    if (window.GiveawayDemo && window.GiveawayDemo.isDemo(window.location.search)) {
      runDemo();
      return;
    }
    load();
  }

  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
  else start();
})();
