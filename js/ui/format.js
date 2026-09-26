/* ==========================================================================
   PMS.vformat - shared view formatting helpers: badges for status/priority,
   avatar, progress chips, tag chips, meta lookups (by key).
   Uses current i18n + store data. Keeps views DRY.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;

  function statusBadge(statusKey, entity, opts) {
    var list = entity === "project" ? PMS.store.data.projectStatuses : PMS.store.data.taskStatuses;
    var s = (list || []).find(function (x) { return x.key === statusKey; });
    var name = s ? PMS.i18n.trilingual(s.name)(s.name) : statusKey;
    var color = s ? s.color : "#6b7280";
    var badge = h("span.badge", {
      style: { background: hexToSoft(color), color: color, border: "1px solid " + hexToSoft(color, 0.6) }
    });
    badge.appendChild(h("span.badge-dot"));
    badge.appendChild(h("span", { text: name }));
    return badge;
  }

  function priorityBadge(prioKey) {
    var p = (PMS.store.data.priorities || []).find(function (x) { return x.key === prioKey; });
    var name = p ? PMS.i18n.trilingual(p.name)(p.name) : prioKey;
    var color = p ? p.color : "#6b7280";
    var badge = h("span.badge", {
      style: { background: hexToSoft(color), color: color, border: "1px solid " + hexToSoft(color, 0.6) }
    });
    badge.appendChild(h("span.badge-dot"));
    badge.appendChild(h("span", { text: name }));
    return badge;
  }

  function projectBadge(projectId) {
    var p = PMS.repos.projects.get(projectId);
    return h("span", { text: p ? p.name : "—" });
  }

  function avatar(person, size) {
    if (!person) return h("span.avatar", { text: "?", style: { background: "#9ca3af" } });
    var a = PMS.utils.avatarFor(PMS.utils.deepClone(person));
    var el = h("span.avatar" + (size === "lg" ? ".avatar-lg" : ""), {
      attrs: { title: person.name }
    });
    el.style.background = a.color;
    el.textContent = a.initials;
    return el;
  }

  function personChip(personId) {
    var p = PMS.repos.people.get(personId);
    if (!p) return h("span.chip", { text: "?" });
    var el = h("span.chip", { style: { display: "inline-flex", alignItems: "center", gap: "6px" } });
    el.appendChild(avatar(p));
    el.appendChild(h("span", { text: p.name }));
    return el;
  }

  function tagsChips(tags) {
    return (tags || []).map(function (tag) { return h("span.chip", { text: tag }); });
  }

  function progressChip(percent) {
    var el = h("span.u-flex", { style: { gap: "6px" } });
    el.appendChild(h("span.progress-track", { style: { width: "80px", height: "8px", display: "inline-block" } }, [h("span.progress-fill", { style: { width: Math.round(percent) + "%" } })]));
    el.appendChild(h("span.progress-label", { text: PMS.utils.pct(percent) }));
    return el;
  }

  function hexToSoft(hex, alpha) {
    var a = alpha === undefined ? 0.14 : alpha;
    var m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return "rgba(128,128,128,0.15)";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  PMS.vformat = {
    statusBadge: statusBadge,
    priorityBadge: priorityBadge,
    projectBadge: projectBadge,
    avatar: avatar,
    personChip: personChip,
    tagsChips: tagsChips,
    progressChip: progressChip,
    hexToSoft: hexToSoft
  };
})(window.PMS);