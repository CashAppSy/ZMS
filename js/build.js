/* ==========================================================================
   PMS.build - which version of the app this device is actually running.

   WHY THIS EXISTS: the app is plain static files with no build step and no
   deploy pipeline, so every device loads whatever copy of the folder it happens
   to have. When several people run several copies, "did my device get the fix?"
   is unanswerable from the inside - the only visible symptom is that a bug that
   was fixed weeks ago still reproduces. That cost real debugging time, so the
   version is now printed on screen (Settings -> About, and the Cloud card).

   HOW TO UPDATE: bump `version` by 1 in every commit that changes behaviour a
   user could notice, and set `released` to that commit's date. Keep it a plain
   integer so it can be compared without knowing what changed.
   ========================================================================== */
(function (PMS) {
  "use strict";
  PMS.build = {
    version: 7,
    released: "2026-10-05"
  };
})(window.PMS);