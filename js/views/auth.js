/* ==========================================================================
   PMS.authUI - login screen + first-run admin setup.
   Renders into #auth-root (a fixed overlay shown before the app shell).
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };
  var done = function () {};

  function field(label, input) {
    var wrap = h("div.field", { style: { marginBlockEnd: "12px", textAlign: "start" } });
    wrap.appendChild(h("label.form-label", { text: label }));
    input.classList.add("input");
    input.classList.add("input-block");
    wrap.appendChild(input);
    return wrap;
  }

  function card(title, form) {
    var shell = h("div.shell-min");
    var brand = h("div.auth-brand");
    brand.appendChild(h("span.brand-logo.auth-logo", { text: "PM" }));
    brand.appendChild(h("span", { text: t("app.name") }));
    var cardEl = h("div.card.auth-card");
    cardEl.appendChild(h("h2.auth-title", { text: title }));
    cardEl.appendChild(form);
    shell.appendChild(brand);
    shell.appendChild(cardEl);
    return shell;
  }

  function setError(form, key) {
    var msg = PMS.authUI.errorMessage(key);
    var line = form.querySelector(".auth-error");
    if (!line) {
      line = h("div.auth-error", { text: msg });
      form.appendChild(line);
    } else line.textContent = msg;
  }

  /* ---------------- first-run: create the admin account ---------------- */
  function renderSetup(root) {
    var people = PMS.repos ? PMS.repos.people.all() : [];
    var activePeople = people.filter(function (p) { return p.status !== "inactive"; });

    var userInput = h("input", { type: "text", name: "username", autocomplete: "username", placeholder: t("auth.usernamePlaceholder"), required: true });
    var passInput = h("input", { type: "password", name: "password", autocomplete: "new-password", placeholder: "••••••••", required: true });
    var pass2Input = h("input", { type: "password", name: "password2", autocomplete: "new-password", placeholder: "••••••••", required: true });

    var form = h("form", { style: { marginTop: "4px" } });
    form.appendChild(h("p.u-muted", { text: t("auth.setupDesc"), style: { marginBlockEnd: "14px" } }));

    if (activePeople.length) {
      var sel = h("select.select", { name: "personId" });
      sel.appendChild(h("option", { value: "", text: t("auth.noPerson") }));
      activePeople.forEach(function (p) {
        sel.appendChild(h("option", { value: p.id, text: p.name + (p.jobTitle ? " — " + p.jobTitle : "") }));
      });
      form.appendChild(field(t("auth.linkPerson"), sel));
    }

    form.appendChild(field(t("auth.username"), userInput));
    form.appendChild(field(t("auth.password"), passInput));
    form.appendChild(field(t("auth.confirmPassword"), pass2Input));

    var btnRow = h("div.auth-actions");
    var submit = h("button.btn.btn-primary.btn-block", { type: "submit", text: t("auth.createAdmin") });
    btnRow.appendChild(submit);
    form.appendChild(btnRow);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (passInput.value !== pass2Input.value) { setError(form, "mismatch"); return; }
      var personId = (form.querySelector("[name=personId]") || {}).value || null;
      var res = PMS.auth.createUser({
        username: userInput.value,
        password: passInput.value,
        personId: personId,
        role: "admin",
        name: personId ? null : userInput.value
      });
      if (res.error) { setError(form, res.error); return; }
      var lg = PMS.auth.login(userInput.value, passInput.value);
      if (lg.error) { setError(form, lg.error); return; }
      PMS.toast.show(t("auth.adminCreated"), "success");
      root.innerHTML = "";
      done();
    });

    root.appendChild(card(t("auth.setupTitle"), form));
  }

  /* ---------------- login ---------------- */
  function renderLogin(root) {
    var userInput = h("input", { type: "text", name: "username", autocomplete: "username", placeholder: t("auth.usernamePlaceholder"), required: true });
    var passInput = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder: "••••••••", required: true });

    var form = h("form", { style: { marginTop: "4px" } });
    form.appendChild(field(t("auth.username"), userInput));
    form.appendChild(field(t("auth.password"), passInput));

    var btnRow = h("div.auth-actions");
    var submit = h("button.btn.btn-primary.btn-block", { type: "submit", text: t("auth.login") });
    btnRow.appendChild(submit);
    form.appendChild(btnRow);
    form.appendChild(h("p.u-muted", { text: t("auth.localCaveat"), style: { marginBlockStart: "12px", fontSize: "0.78rem" } }));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var res = PMS.auth.login(userInput.value, passInput.value);
      if (res.error) { setError(form, res.error); return; }
      root.innerHTML = "";
      done();
    });

    root.appendChild(card(t("auth.loginTitle"), form));
    userInput.focus();
  }

  function errorMessage(code) {
    switch (code) {
      case "mismatch": return t("auth.mismatch");
      case "invalid": case "password": return t("auth.invalidCredentials");
      case "inactive": return t("auth.inactive");
      case "username": return t("auth.usernameError");
      case "duplicate": return t("auth.duplicate");
      case "lastAdmin": return t("auth.lastAdmin");
      case "self": return t("auth.selfDelete");
      case "notfound": return t("auth.notFound");
      default: return t("errors.generic");
    }
  }

  function show(onSuccess) {
    done = onSuccess || function () {};
    var root = document.getElementById("auth-root");
    if (!root) return;
    // match the persisted language & theme before showing the overlay
    PMS.i18n.setLang(PMS.store.data.settings.lang || "en");
    if (PMS.app && PMS.app.applyTheme) PMS.app.applyTheme(PMS.store.data.settings.theme || "light");
    root.innerHTML = "";
    root.style.display = "flex";
    if (!PMS.auth.configured()) renderSetup(root);
    else renderLogin(root);
    document.title = PMS.i18n.t("auth.loginTitle") + " — " + PMS.i18n.t("app.name");
  }

  function hide() {
    var root = document.getElementById("auth-root");
    if (root) root.style.display = "none";
  }

  PMS.authUI = {
    show: show,
    hide: hide,
    errorMessage: errorMessage,
    displayName: function (u) {
      if (!u) return "";
      if (u.personId && PMS.repos) {
        var p = PMS.repos.people.get(u.personId);
        if (p) return p.name;
      }
      return u.name || u.username;
    }
  };
})(window.PMS);