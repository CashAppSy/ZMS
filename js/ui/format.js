/* ==========================================================================
   PMS.vformat - shared view formatting helpers: badges for status/priority,
   avatar, progress chips, tag chips, meta lookups (by key).
   Uses current i18n + store data. Keeps views DRY.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  function t(key) { return PMS.i18n.t(key); }

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

  function progressChip(percent, precise) {
    var el = h("span.u-flex", { style: { gap: "6px" } });
    el.appendChild(h("span.progress-track", { style: { width: "80px", height: "8px", display: "inline-block" } }, [h("span.progress-fill", { style: { width: Math.round(percent) + "%" } })]));
    // `precise` keeps a band-limited value (74.9) from being printed as 75%.
    el.appendChild(h("span.progress-label", { text: precise ? PMS.utils.pctBand(percent) : PMS.utils.pct(percent) }));
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

  // Who created a record (a task, a meeting, ...). The name is stored with the
  // record, so it survives a cloud round-trip to a device that has no user
  // account for that id. The id and the linked person are the fallbacks.
  function creatorOf(rec) {
    if (!rec) return "";
    if (rec.createdByName) return rec.createdByName;
    if (rec.createdBy && PMS.auth && PMS.auth.userById) {
      var u = PMS.auth.userById(rec.createdBy);
      if (u) return u.name || u.username || u.email || "";
    }
    if (rec.createdByPersonId) {
      var p = PMS.repos.people.get(rec.createdByPersonId);
      if (p) return p.name;
    }
    return "";
  }

  // A small round avatar with the creator's initial, plus their name. Used
  // next to tasks and meetings so "who made this" is one glance away.
  function creatorChip(rec) {
    var name = creatorOf(rec);
    if (!name) return null;
    var initial = name.trim().charAt(0).toUpperCase();
    var el = h("span.chip.chip-creator", { attrs: { title: name } });
    el.appendChild(h("span.cc-avatar", { text: initial }));
    el.appendChild(h("span.cc-name", { text: name }));
    return el;
  }

  // ---- the task network, shown the same way everywhere --------------------
  //
  // Four views and the detail screen all have to answer "what does this task
  // wait on, is it held up, and is it on the critical path" and none of them
  // should invent its own answer. These build the pieces; the engine behind
  // them is PMS.dependencies.
  //
  // The type is spelled out rather than abbreviated to FS/FF/SS/SF on its own:
  // those four letters mean nothing to somebody who has not memorised the
  // vocabulary, and a chip is read faster than a sentence.

  var TYPE_GLYPH = { FS: "→", FF: "⇥", SS: "↔", SF: "⇤" };

  // One link as a chip: "waits for #4, finish to start, 2 days late".
  function depChip(dep, number, opts) {
    opts = opts || {};
    var chip = h("span.dep-chip.dep-type-" + dep.type + (opts.broken ? ".dep-broken" : "") + (opts.done ? ".dep-done" : ""));
    var glyph = h("span.dep-glyph", { text: TYPE_GLYPH[dep.type] || "→" });
    chip.appendChild(glyph);
    var num = (number === undefined || number === null) ? "" : "#" + number;
    chip.appendChild(h("span.dep-type", { text: PMS.dependencies.label(dep.type) }));
    if (num) chip.appendChild(h("span.u-muted", { text: num }));
    if (dep.lag) {
      chip.appendChild(h("span.dep-lag", {
        text: (dep.lag > 0 ? "+" : "") + dep.lag + "d",
        attrs: { title: t("deps.lagHint") }
      }));
    }
    if (opts.title) chip.setAttribute("title", opts.title);
    return chip;
  }

  // The small set of facts a row, card or pill can carry: blocked, on the
  // critical path, slack. Empty when there is nothing to say, so a caller can
  // append the result unconditionally.
  function depMarkers(data, task, analysis) {
    var out = [];
    if (!task) return out;
    var DD = PMS.dependencies;
    var blocked = DD.blocking(data, task);
    if (blocked.length) {
      out.push(h("span.dep-marker.dep-marker-blocked", {
        text: "⛔ " + t("deps.blocked"),
        attrs: {
          title: t("deps.blockedBy") + ": " + blocked.map(function (b) {
            return (b.task.title || "") + " (" + DD.label(b.dep.type) + ")";
          }).join(", ")
        }
      }));
    }
    if (DD.isCritical(analysis, task.id)) {
      out.push(h("span.dep-marker.dep-marker-critical", {
        text: "◆ " + t("deps.critical"),
        attrs: { title: t("deps.criticalHint") }
      }));
    } else {
      var slack = DD.slackOf(analysis, task.id);
      if (slack !== null && slack > 0) {
        out.push(h("span.dep-marker.dep-marker-slack", {
          text: "+" + Math.round(slack) + "d",
          attrs: { title: t("deps.slack") }
        }));
      }
    }
    return out;
  }

  // One line for a list of links: what this task waits on.
  function depSummary(data, task, numbers) {
    var DD = PMS.dependencies;
    // predecessors() already drops links whose task is gone, so this only has
    // to confirm the link really exists in the graph. The edge list is built
    // once - this function is called once per row of a list.
    var linked = {};
    DD.edges(data).forEach(function (e) { if (e.toId === task.id) linked[e.fromId] = true; });
    var preds = DD.predecessors(task).filter(function (d) { return linked[d.id]; });
    var wrap = h("span.dep-summary");
    preds.forEach(function (d) {
      var p = (data.tasks || []).find(function (x) { return x && x.id === d.id; });
      var ok = p ? DD.isSatisfied(d, p, task) : null;
      wrap.appendChild(depChip(d, numbers && numbers[d.id], {
        broken: ok === false,
        done: p ? DD.isTaskDone(data, p) : false,
        title: (p ? p.title : "") + " — " + DD.label(d.type)
      }));
    });
    var succs = DD.successors(data, task.id);
    if (succs.length) {
      wrap.appendChild(h("span.u-muted", {
        text: "→ " + succs.length + " " + t("deps.chain"),
        attrs: { title: t("deps.succs") }
      }));
    }
    return wrap;
  }

  PMS.vformat = {
    statusBadge: statusBadge,
    priorityBadge: priorityBadge,
    projectBadge: projectBadge,
    avatar: avatar,
    personChip: personChip,
    tagsChips: tagsChips,
    progressChip: progressChip,
    hexToSoft: hexToSoft,
    creatorOf: creatorOf,
    creatorChip: creatorChip,
    depChip: depChip,
    depMarkers: depMarkers,
    depSummary: depSummary
  };
})(window.PMS);
