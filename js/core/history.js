/* Reversible changes: retain edited records, not fifty complete datasets. */
(function (PMS) {
  "use strict";
  var clone = PMS.utils.deepClone;
  function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function records(a) {
    return Array.isArray(a) && a.every(function (r) { return r && typeof r.id === "string"; }) && new Set(a.map(function (r) { return r.id; })).size === a.length;
  }
  function diff(before, after) {
    var patches = [];
    new Set(Object.keys(before).concat(Object.keys(after))).forEach(function (key) {
      var a = before[key], b = after[key];
      if (equal(a, b)) return;
      if (records(a) && records(b)) {
        var old = new Map(a.map(function (r) { return [r.id, r]; }));
        var next = new Map(b.map(function (r) { return [r.id, r]; }));
        var changes = [];
        new Set(Array.from(old.keys()).concat(Array.from(next.keys()))).forEach(function (id) {
          if (!equal(old.get(id), next.get(id))) changes.push({ id: id, before: clone(old.get(id)), after: clone(next.get(id)) });
        });
        patches.push({ key: key, records: changes, beforeOrder: a.map(function (r) { return r.id; }), afterOrder: b.map(function (r) { return r.id; }) });
      } else {
        patches.push({ key: key, before: clone(a), after: clone(b) });
      }
    });
    return patches;
  }
  function apply(data, patches, direction) {
    patches.forEach(function (patch) {
      if (patch.records) {
        var map = new Map((data[patch.key] || []).map(function (r) { return [r.id, r]; }));
        patch.records.forEach(function (change) {
          var value = change[direction];
          if (value === undefined) map.delete(change.id);
          else map.set(change.id, clone(value));
        });
        data[patch.key] = patch[direction + "Order"].map(function (id) { return map.get(id); });
      } else if (patch[direction] === undefined) delete data[patch.key];
      else data[patch.key] = clone(patch[direction]);
    });
    return data;
  }
  function event(patches, desc) {
    var ids = {};
    patches.forEach(function (p) { if (p.records) ids[p.key] = p.records.map(function (r) { return r.id; }); });
    return { desc: desc, collections: patches.map(function (p) { return p.key; }), ids: ids };
  }
  PMS.history = { diff: diff, apply: apply, event: event };
})(window.PMS);
