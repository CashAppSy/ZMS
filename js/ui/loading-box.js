/* ==========================================================================
   PMS.loadingBox - a small floating "still working" box.
   Shows a spinner + status text whenever cloud sync is in flight and the
   connection is bad (slow for more than SLOW_MS, or offline), so a frozen-
   looking screen on a weak network is clearly labeled as "syncing".
   Reuses the app-wide event bus; safe no-ops when cloud sync is never used.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var SLOW_MS = 2000;
  var cloudActiveOverride = null;
  var box = null;
  var textEl = null;
  var inflight = 0;
  var slowTimer = null;
  var visible = null; // "busy" | "slow" | "offline"

  function ensure() {
    if (box) return;
    box = PMS.dom.h("div.loading-box.is-hidden", {
      id: "loading-box",
      attrs: { role: "status", "aria-live": "polite" }
    });
    box.appendChild(PMS.dom.h("span.spinner"));
    box.appendChild(PMS.dom.h("span.status-dot"));
    textEl = PMS.dom.h("span.loading-text");
    box.appendChild(textEl);
    document.body.appendChild(box);
  }

  function isCloudActive() {
    if (cloudActiveOverride !== null) return cloudActiveOverride === true;
    return !!(PMS.cloudsync && PMS.cloudsync.isEnabled && PMS.cloudsync.isEnabled());
  }

  function apply() {
    var reason = null;
    var offline = !!(PMS.network && PMS.network.isOnline && !PMS.network.isOnline());
    if (offline && isCloudActive()) reason = "offline";
    else if (!offline) reason = visible;

    box.classList.toggle("is-busy", reason === "busy");
    box.classList.toggle("is-slow", reason === "slow");
    box.classList.toggle("is-offline", reason === "offline");
    if (reason === "offline") textEl.textContent = PMS.i18n.t("cloud.offline");
    else if (reason === "slow") textEl.textContent = PMS.i18n.t("cloud.slowNet");
    else if (reason === "busy") textEl.textContent = PMS.i18n.t("cloud.syncing");
    box.classList.toggle("is-hidden", !reason);
    box.setAttribute("aria-hidden", reason ? "false" : "true");
  }

  function clearTimer() {
    if (slowTimer) { clearTimeout(slowTimer); slowTimer = null; }
  }

  function onInflight(e) {
    ensure();
    if (e && e.busy) {
      inflight++;
      if (e.op === "boot") {
        clearTimer();
        visible = "busy";
        apply();
      } else {
        clearTimer();
        slowTimer = setTimeout(function () {
          slowTimer = null;
          if (inflight > 0) { visible = "slow"; apply(); }
        }, SLOW_MS);
      }
    } else {
      inflight = Math.max(0, inflight - 1);
      clearTimer();
      if (visible === "busy" || visible === "slow") visible = null;
      if (inflight === 0) apply();
    }
  }

  function onNetwork() {
    ensure();
    apply();
  }

  PMS.bus.on("cloud:inflight", onInflight);
  PMS.bus.on("network:status", onNetwork);

  PMS.loadingBox = {
    SLOW_MS: SLOW_MS,
    show: function (role) { ensure(); visible = role || "busy"; apply(); },
    hide: function () { visible = null; if (box) apply(); },
    isVisible: function () { return !!box && !box.classList.contains("is-hidden"); },
    visibleReason: function () {
      return box && !box.classList.contains("is-hidden")
        ? (box.classList.contains("is-slow") ? "slow" : box.classList.contains("is-offline") ? "offline" : "busy")
        : null; }
  };

  if (PMS.network && PMS.network.start) PMS.network.start();

  // test-only: shrink the slow-timer and pin the cloud-active state so the
  // test harness can exercise every path fast (never in a real browser)
  if (typeof window !== "undefined" && window.__ZMS_TEST__) {
    PMS.loadingBox._setSlowMs = function (ms) { SLOW_MS = ms || 2000; };
    PMS.loadingBox._setCloudActive = function (flag) {
      cloudActiveOverride = (flag === null || flag === undefined) ? null : !!flag;
      if (box) apply();
    };
  }
})(window.PMS);