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
})();
