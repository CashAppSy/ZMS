/* ==========================================================================
   PMS.utils - shared helpers: escaping (XSS), dates, debounce, cloning,
   DOM helpers.
   ========================================================================== */
(function (PMS) {
  "use strict";

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(str) {
    return escapeHtml(str);
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function throttle(fn, limit) {
    var last = 0, t;
    return function () {
      var now = Date.now(), ctx = this, args = arguments;
      var remaining = limit - (now - last);
      if (remaining <= 0) {
        last = now;
        fn.apply(ctx, args);
      }
    };
  }

  function deepClone(obj) {
    if (obj === null || typeof obj !== "object") return obj;
    if (obj instanceof Date) return new Date(obj.getTime());
    if (Array.isArray(obj)) return obj.map(deepClone);
    var out = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        out[k] = deepClone(obj[k]);
      }
    }
    return out;
  }

  function nowISO() {
    return new Date().toISOString();
  }

  /* ---------- Dates (local timezone safe) ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function toISODate(d) {
    if (!d) return "";
    if (typeof d === "string") d = new Date(d);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function parseDate(str, endOfDay) {
    if (!str) return null;
    var d = new Date(str);
    if (isNaN(d)) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d;
  }

  function todayISO() { return toISODate(new Date()); }

  // locale formatting via i18n (set later). formats a date (ISO) -> display string
  function formatDate(iso, i18n, opts) {
    if (!iso) return "--";
    var d = new Date(iso);
    if (isNaN(d)) return "--";
    var loc = i18n && i18n.lang === "ar" ? "ar-EG" : "en-GB";
    try {
      return d.toLocaleDateString(loc, opts || { year: "numeric", month: "short", day: "numeric" });
    } catch (e) {
      return iso;
    }
  }

  function diffDays(aISO, bISO) {
    var a = parseDate(aISO), b = parseDate(bISO);
    if (!a || !b) return 0;
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  }

  /* ---------- Misc ---------- */
  function hashCode(str) {
    var h = 0;
    if (!str) return h;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
  }

  var COLOR_PALETTE = [
    "#2563eb", "#7c3aed", "#db2777", "#ea580c", "#16a34a",
    "#0891b2", "#ca8a04", "#9333ea", "#0d9488", "#e11d48",
    "#4f46e5", "#65a30d", "#f43f5e", "#0284c7", "#b45309"
  ];

  function colorForSeed(str) {
    return COLOR_PALETTE[hashCode(str) % COLOR_PALETTE.length];
  }

  // Deterministic color for a person avatar
  function avatarFor(person) {
    var name = person && person.name ? person.name : "?";
    var initials = String(name).trim().split(/\s+/).slice(0, 2).map(function (w) {
      return w.charAt(0).toUpperCase();
    }).join("");
    return { initials: initials || "?", color: colorForSeed(name) };
  }

  function money(n, currency, i18n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    var loc = i18n && i18n.lang === "ar" ? "ar-EG" : "en-GB";
    var sym = currency || "";
    try {
      return (sym ? sym + " " : "") + new Intl.NumberFormat(loc, { maximumFractionDigits: 2 }).format(n);
    } catch (e) { return (sym ? sym + " " : "") + n; }
  }

  function hours(n, i18n) {
    if (n === null || n === undefined || isNaN(n)) return "--";
    var loc = i18n && i18n.lang === "ar" ? "ar-EG" : "en-GB";
    try {
      return new Intl.NumberFormat(loc, { maximumFractionDigits: 1 }).format(n) + "h";
    } catch (e) { return n + "h"; }
  }

  function pct(n) {
    if (n === null || n === undefined || isNaN(n)) return "0%";
    return Math.round(n) + "%";
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function debouncedById(fn, wait) {
    var timers = {};
    return function (id) {
      clearTimeout(timers[id]);
      timers[id] = setTimeout(function () { fn(id); }, wait);
    };
  }

  // trigger a DOM event (for tests)
  function trigger(el, type) {
    if (!el) return;
    var ev = new Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }

  // Download helper
  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  PMS.utils = {
    escapeHtml: escapeHtml, escapeAttr: escapeAttr,
    debounce: debounce, throttle: throttle,
    deepClone: deepClone, nowISO: nowISO,
    toISODate: toISODate, parseDate: parseDate, todayISO: todayISO,
    formatDate: formatDate, diffDays: diffDays, hashCode: hashCode,
    colorForSeed: colorForSeed, avatarFor: avatarFor,
    money: money, hours: hours, pct: pct, clamp: clamp,
    debouncedById: debouncedById, trigger: trigger, download: download
  };
})(window.PMS);