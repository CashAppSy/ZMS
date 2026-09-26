/* ==========================================================================
   PMS.i18n - translation engine
   Usage: PMS.i18n.t('nav.dashboard') -> "Dashboard"
   Supports {var} interpolation. Falls back to en, then to key itself.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var resources = {};
  var lang = "en";
  var supported = ["en", "ar"];

  function register(code, dict) {
    resources[code] = dict || {};
  }

  if (PMS.i18nFiles) {
    for (var code in PMS.i18nFiles) register(code, PMS.i18nFiles[code]);
  }

  function pick(dict, path) {
    var parts = path.split(".");
    var cur = dict;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== "object") return undefined;
      cur = cur[parts[i]];
    }
    return typeof cur === "string" || typeof cur === "number" ? cur : undefined;
  }

  function t(key, vars) {
    var v = pick(resources[lang], key);
    if (v === undefined && lang !== "en") v = pick(resources.en, key);
    if (v === undefined) v = key;
    if (vars) {
      v = String(v).replace(/\{(\w+)\}/g, function (m, name) {
        return vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : m;
      });
    }
    return v;
  }

  function setLang(code) {
    if (!resources[code]) code = "en";
    lang = code;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  }

  function getLang() { return lang; }

  function trilingual(code) {
    // for bilingual fields {en, ar}
    return function (obj) {
      if (!obj) return "";
      if (lang === "ar" && obj.ar != null) return obj.ar;
      return obj.en != null ? obj.en : (obj.ar != null ? obj.ar : "");
    };
  }

  // Plural-ish helper (Arabic/English both handled by simple intl formatting)
  function n(count) {
    return count;
  }

  PMS.i18n = { t: t, setLang: setLang, getLang: getLang, register: register, trilingual: trilingual, n: n };
})(window.PMS);