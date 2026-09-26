/* ==========================================================================
   PMS - Global namespace
   Everything attaches to window.PMS to avoid globals.
   ========================================================================== */
(function () {
  "use strict";
  window.PMS = {
    version: "1.0.0",
    _modules: {},
    def: function (name, module) {
      this._modules[name] = module;
    }
  };
})();