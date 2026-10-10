/* Local change tracking, independent of Firebase transport and authentication. */
(function (PMS) {
  "use strict";
  PMS.syncMirror = { create: function (MIRROR_KEY) {
  function loadMirror() {
    try { return JSON.parse(window.localStorage.getItem(MIRROR_KEY) || "null") || {}; }
    catch (e) { return {}; }
  }
  function saveMirror(m) {
    try { window.localStorage.setItem(MIRROR_KEY, JSON.stringify(m)); } catch (e) {}
  }
  function mirrorFor(col) { return loadMirror()[col] || {}; }
  function setMirrorFor(col, map) {
    var m = loadMirror();
    m[col] = map || {};
    saveMirror(m);
  }

  function statusTrack(rec) {
    return {
      updatedAt: rec.updatedAt || null,
      status: rec.status === undefined ? null : rec.status,
      progress: rec.progress === undefined ? null : rec.progress,
      activity: rec.activity === undefined ? null : PMS.utils.deepClone(rec.activity)
    };
  }

  function statusEquals(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.updatedAt === b.updatedAt &&
      a.status === b.status &&
      a.progress === b.progress &&
      JSON.stringify(a.activity || null) === JSON.stringify(b.activity || null);
  }

  // Mirror entry for a per-record document. Tasks/projects track the status
  // fields (for the assignee status-only path); a MEETING has no status,
  // progress or activity, so tracking them would store meaningless nulls and
  // make the mirror misleading — its updatedAt alone decides changed/not.
  // createdByPersonId is kept in the mirror on purpose: once a record is deleted
  // locally there is no record left to read the creator from, and the mirror is
  // the only place that can still tell whether this account may delete it in
  // the cloud (auth.js canDeleteRecord).
  function recordTrack(cname, rec) {
    if (cname === "meetings") {
      return { updatedAt: (rec && rec.updatedAt) || null, createdByPersonId: (rec && rec.createdByPersonId) || null };
    }
    var t = statusTrack(rec);
    t.createdByPersonId = (rec && rec.createdByPersonId) || null;
    return t;
  }

  // Serialized equality for a single status field (activity is an array).
  function statusFieldEquals(key, localRec, snap) {
    if (key === "activity") {
      return JSON.stringify(localRec[key] || null) === JSON.stringify(snap[key] || null);
    }
    return (localRec[key] === undefined ? null : localRec[key]) === snap[key];
  }

  return { forCollection: mirrorFor, setCollection: setMirrorFor,
    statusTrack: statusTrack, statusEquals: statusEquals, recordTrack: recordTrack,
    statusFieldEquals: statusFieldEquals };
  } };
})(window.PMS);
