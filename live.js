(function () {
  window.va = window.va || function () {
    (window.vaq = window.vaq || []).push(arguments);
  };

  function track(name, data) {
    try {
      window.va("event", { name: name, data: data || {} });
    } catch (error) {
      /* A failed analytics call must not stop the click. */
    }
  }

  document.querySelectorAll("[data-track]").forEach(function (link) {
    link.addEventListener("click", function () {
      var button = link.getAttribute("data-track");
      if (button) track("click", { button: button });
    });
  });

  var audience = document.getElementById("audience");
  if (audience) {
    var totalEl = audience.querySelector(".audience-total");
    var shown = null;
    var frame = 0;
    var FOLLOW_MS = 60000;
    var numberFormat = new Intl.NumberFormat("ro-RO");

    function formatCount(value) {
      return numberFormat.format(Math.round(value));
    }

    function paintTotal(value) {
      shown = Math.round(value);
      if (totalEl) totalEl.textContent = formatCount(shown);
    }

    function animateTotal(next) {
      next = Math.round(next);
      var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (shown == null || shown === next || reduce) {
        paintTotal(next);
        return;
      }
      var from = shown;
      var start = performance.now();
      var duration = 700;
      cancelAnimationFrame(frame);
      function step(now) {
        var t = Math.min(1, (now - start) / duration);
        var eased = 1 - Math.pow(1 - t, 3);
        paintTotal(from + (next - from) * eased);
        if (t < 1) frame = requestAnimationFrame(step);
        else paintTotal(next);
      }
      frame = requestAnimationFrame(step);
    }

    function applyFollowers(data) {
      if (!data || typeof data.total !== "number" || !(data.total > 0) || !totalEl) return;
      audience.removeAttribute("title");
      animateTotal(data.total);
      audience.hidden = false;
    }

    function pullFollowers() {
      if (document.hidden) return;
      fetch("/api/followers", { headers: { Accept: "application/json" }, cache: "no-store" })
        .then(function (response) {
          if (!response.ok) return null;
          return response.json();
        })
        .then(function (data) {
          if (data) applyFollowers(data);
        })
        .catch(function () {
          /* Leave the last follower line in place. */
        });
    }

    pullFollowers();
    setInterval(pullFollowers, FOLLOW_MS);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) pullFollowers();
    });
  }

  var kick = document.querySelector('[data-track="kick"]');
  if (!kick) return;

  var badge = kick.querySelector(".live-badge");
  var status = document.getElementById("live-status");
  var announced = false;
  var POLL_MS = 90000;

  function apply(data) {
    var live = !!(data && data.live === true);
    kick.classList.toggle("is-live", live);
    if (badge) badge.hidden = !live;

    if (!live) {
      kick.removeAttribute("title");
      kick.removeAttribute("aria-label");
      if (announced && status) status.textContent = "KIP nu mai este live.";
      announced = false;
      return;
    }

    var parts = ["LIVE acum"];
    if (typeof data.viewers === "number" && isFinite(data.viewers) && data.viewers >= 0) {
      parts.push(new Intl.NumberFormat("ro-RO").format(Math.round(data.viewers)) + " spectatori");
    }
    if (typeof data.title === "string" && data.title.trim()) {
      parts.push(data.title.trim().slice(0, 140));
    }
    kick.title = parts.join(" · ");
    kick.setAttribute("aria-label", "Kick, " + parts.join(", "));
    if (!announced && status) status.textContent = "KIP este live acum pe Kick.";
    announced = true;
  }

  var params = new URLSearchParams(location.search);
  if (params.has("live")) {
    var flag = params.get("live");
    var forced = flag === "1" || flag === "true";
    var viewers = params.get("viewers");
    var count = viewers == null || viewers === "" ? null : Number(viewers);
    apply({
      live: forced,
      viewers: typeof count === "number" && isFinite(count) ? count : null,
      title: params.get("title") || "",
    });
    return;
  }

  function tick() {
    if (document.hidden) return;
    fetch("/api/live", { headers: { Accept: "application/json" } })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (data) {
        if (data && typeof data.live === "boolean") apply(data);
      })
      .catch(function () {
        /* Leave the button in its normal state. */
      });
  }

  tick();
  setInterval(tick, POLL_MS);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) tick();
  });

  var giveawaySub = document.getElementById("giveaway-sub");
  if (giveawaySub) {
    var giveawayDemo = new URLSearchParams(window.location.search).get("demo");
    if (giveawayDemo === "ended" || giveawayDemo === "closed") {
      giveawaySub.hidden = false;
      giveawaySub.textContent = giveawayDemo === "ended" ? "Încheiat" : "Extragere";
    } else {
      fetch("/api/giveaway/stats", { headers: { Accept: "application/json" } })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data || data.configured === false) return;
          if (data.revealed) {
            giveawaySub.hidden = false;
            giveawaySub.textContent = "Încheiat";
            return;
          }
          var closeAt = data.window && Date.parse(data.window.close);
          if (closeAt && Date.now() >= closeAt) {
            giveawaySub.hidden = false;
            giveawaySub.textContent = "Extragere";
          }
        })
        .catch(function () {
          /* The tile stays usable without a status line. */
        });
    }
  }
})();
