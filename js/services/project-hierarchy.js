/* Project hierarchy invariants, shared by loading, imports and editing. */
(function (PMS) {
  "use strict";
  function index(projects) {
    return new Map((projects || []).map(function (p) { return [p.id, p]; }));
  }
  function canParent(projects, id, parentId) {
    if (!parentId) return true;
    var map = index(projects), seen = new Set(), cursor = parentId;
    while (cursor) {
      if (cursor === id || seen.has(cursor) || !map.has(cursor)) return false;
      seen.add(cursor);
      cursor = map.get(cursor).parentId;
    }
    return true;
  }
  // Detach only invalid edges. Preserve ids, records, task links and valid nesting.
  function repair(projects) {
    var map = index(projects), done = new Set(), repaired = [];
    (projects || []).forEach(function (p) {
      var cursor = p, path = new Set();
      while (cursor && !done.has(cursor.id)) {
        path.add(cursor.id);
        if (cursor.parentId && (!map.has(cursor.parentId) || path.has(cursor.parentId))) {
          repaired.push({ id: cursor.id, parentId: cursor.parentId });
          cursor.parentId = null;
        }
        cursor = cursor.parentId ? map.get(cursor.parentId) : null;
      }
      path.forEach(function (id) { done.add(id); });
    });
    return repaired;
  }
  PMS.projectHierarchy = { canParent: canParent, repair: repair };
})(window.PMS);
