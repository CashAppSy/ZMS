/* ==========================================================================
   PMS.authUI - login screen + first-run admin setup.
   Renders into #auth-root (a fixed overlay shown before the app shell).
   When a cloud project is available (js/cloud-config.js filled) the screen is
   cloud-first: one email + password shared on every device (Firebase Auth),
   with a link back to the classic local accounts for offline use.
   ========================================================================== */
(function (PMS) {
  "use strict";

  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };
  var done = function () {};

  function cloudAvailable() {
    return !!(PMS.cloudsync && PMS.cloudsync.isConfigured &&
      PMS.cloudsync.isConfigured() && PMS.cloudsync.signUpWithPassword);
  }

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

  function linkSwitcher(label, onClick) {
    return h("button.btn.btn-ghost.btn-block", {
      text: label,
      style: { marginBlockStart: "10px" },
      on: { click: function (e) { e.preventDefault(); onClick(); } }
    });
  }

  // Hands control to the app shell. If anything in that hand-off throws the
  // overlay stays on screen with the reason and a retry, instead of the page
  // turning blank until it is refreshed by hand.
  function enterApp(root) {
    try {
      done();
    } catch (e) {
      console.error("[auth] could not open the app:", e);
      root.innerHTML = "";
      var box = h("div.empty-state");
      box.appendChild(h("div.empty-icon", { text: "⚠️" }));
      box.appendChild(h("h3", { text: t("errors.startFailed") }));
      box.appendChild(h("p.u-muted", { text: String((e && e.message) || e) }));
      box.appendChild(h("button.btn.btn-primary", {
        text: t("common.retry"),
        on: { click: function () { window.location.reload(); } }
      }));
      root.appendChild(box);
      root.style.display = "flex";
    }
  }

  function personSelect() {
    var people = PMS.repos ? PMS.repos.people.all() : [];
    var activePeople = people.filter(function (p) { return p.status !== "inactive"; });
    var sel = h("select.select", { name: "personId" });
    sel.appendChild(h("option", { value: "", text: t("auth.noPerson") }));
    activePeople.forEach(function (p) {
      sel.appendChild(h("option", { value: p.id, text: p.name + (p.jobTitle ? " — " + p.jobTitle : "") }));
    });
    return sel;
  }

  /* ------------- shared helpers for cloud auth flows ------------- */
  function bridgeAndEnter(root, res) {
    // keep the cloud identity + role + linked person, creating a slim local
    // record when this device has never seen that uid before. The cloud rules
    // authorize project/task writes by personId (managerId/assignees), so the
    // local mirror must adopt the personId Firebase carries for the account.
    var local = PMS.cloudBridge.userByCloudUid(res.uid);
    if (local) {
      var patch = {};
      // adopt an email changed in the Firebase console (the only way a cloud
      // account's sign-in email can change on the free plan) on the next sign-in
      if (String(local.username || "").trim().toLowerCase() !== String(res.email || "").trim().toLowerCase()) patch.username = String(res.email).trim().toLowerCase();
      if (local.role !== res.role && PMS.cloudsync && PMS.cloudsync.isEnabled && PMS.cloudsync.isEnabled()) patch.role = res.role;
      if ((local.personId || null) !== (res.personId || null)) patch.personId = res.personId || null;
      if (Object.keys(patch).length) {
        PMS.auth.updateUser(local.id, patch);
        local = PMS.auth.userById(local.id);
      }
    } else {
      local = PMS.cloudBridge.register({
        username: res.email, cloudUid: res.uid, role: res.role,
        name: res.displayName || res.email, personId: res.personId || null
      });
    }
    if (!local || local.active === false) {
      PMS.toast.show(t("auth.inactive"), "error");
      renderCloudLogin(root);
      return;
    }
    // heal the linked person's profile email into lockstep with the real
    // Firebase sign-in email (covers emails changed in the Firebase console,
    // which the app cannot see through its own Cloud Functions).
    var healed = String(res.email || "").trim().toLowerCase();
    if (healed && (res.personId || (local && local.personId)) && PMS.repos && PMS.repos.people) {
      var pid = res.personId || (local && local.personId);
      var lp = PMS.repos.people.get(pid);
      if (lp && String(lp.email || "").trim().toLowerCase() !== healed) {
        PMS.repos.people.update(lp.id, { email: healed });
      }
    }
    PMS.cloudBridge.adopt({ id: local.id, cloudUid: local.cloudUid });
    root.innerHTML = "";
    enterApp(root);
  }

  /* ---------------- first-run: classic local admin (defensive, no cloud) ---------------- */
  function renderLocalSetup(root) {
    var userInput = h("input", { type: "text", name: "username", autocomplete: "username", placeholder: t("auth.usernamePlaceholder"), required: true });
    var passInput = h("input", { type: "password", name: "password", autocomplete: "new-password", placeholder: "••••••••", required: true });
    var pass2Input = h("input", { type: "password", name: "password2", autocomplete: "new-password", placeholder: "••••••••", required: true });

    var form = h("form", { style: { marginTop: "4px" } });
    form.appendChild(h("p.u-muted", { text: t("auth.setupDesc"), style: { marginBlockEnd: "14px" } }));

    var people = PMS.repos ? PMS.repos.people.all() : [];
    if (people.some(function (p) { return p.status !== "inactive"; })) {
      form.appendChild(field(t("auth.linkPerson"), personSelect()));
    }

    form.appendChild(field(t("auth.username"), userInput));
    form.appendChild(field(t("auth.password"), passInput));
    form.appendChild(field(t("auth.confirmPassword"), pass2Input));

    var btnRow = h("div.auth-actions");
    var submit = h("button.btn.btn-primary.btn-block", { type: "submit", text: t("auth.createAdmin") });
    btnRow.appendChild(submit);
    form.appendChild(btnRow);
    if (cloudAvailable()) form.appendChild(linkSwitcher(t("auth.cloudSetupLink"), function () { renderCloudSetup(root); }));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (passInput.value !== pass2Input.value) { setError(form, "mismatch"); return; }
      var personId = (form.querySelector("[name=personId]") || {}).value || null;
      var res = PMS.auth.createUser({
        username: userInput.value,
        password: passInput.value,
        personId: personId,
        name: personId ? null : userInput.value
      });
      if (res.error) { setError(form, res.error); return; }
      var lg = PMS.auth.login(userInput.value, passInput.value);
      if (lg.error) { setError(form, lg.error); return; }
      PMS.toast.show(t("auth.adminCreated"), "success");
      root.innerHTML = "";
      enterApp(root);
    });

    root.appendChild(card(t("auth.setupTitle"), form));
  }

  /* ---------------- cloud login ---------------- */
  function renderCloudLogin(root) {
    var emailInput = h("input", { type: "email", name: "username", autocomplete: "email", placeholder: "name@domain.com", required: true });
    var passInput = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder: "••••••••", required: true });

    var form = h("form", { style: { marginTop: "4px" } });
    form.appendChild(h("p.u-muted", { text: t("auth.cloudDesc"), style: { marginBlockEnd: "14px" } }));
    form.appendChild(field(t("auth.cloudEmail"), emailInput));
    form.appendChild(field(t("auth.password"), passInput));

    var submit = h("button.btn.btn-primary.btn-block", { type: "submit", text: t("auth.cloudSignIn") });
    form.appendChild(submit);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      submit.disabled = true;
      submit.textContent = t("auth.cloudWaiting");
      PMS.cloudsync.signInWithPassword({ email: emailInput.value, password: passInput.value })
        .then(function (res) {
          bridgeAndEnter(root, res);
        }).catch(function (err) {
          submit.disabled = false;
          submit.textContent = t("auth.cloudSignIn");
          setError(form, (err && err.userCode) || "generic");
          console.error("[zms] cloud sign-in failed:", err && err.code || err, err);
        });
    });

    root.appendChild(card(t("auth.cloudTitle"), form));
    emailInput.focus();
  }

  /* ---------------- classic local login ---------------- */
  function renderLocalLogin(root) {
    var userInput = h("input", { type: "text", name: "username", autocomplete: "username", placeholder: t("auth.usernamePlaceholder"), required: true });
    var passInput = h("input", { type: "password", name: "password", autocomplete: "current-password", placeholder: "••••••••", required: true });

    var form = h("form", { style: { marginTop: "4px" } });
    form.appendChild(field(t("auth.username"), userInput));
    form.appendChild(field(t("auth.password"), passInput));

    var btnRow = h("div.auth-actions");
    var submit = h("button.btn.btn-primary.btn-block", { type: "submit", text: t("auth.login") });
    btnRow.appendChild(submit);
    form.appendChild(btnRow);
    if (cloudAvailable()) form.appendChild(linkSwitcher(t("auth.cloudLoginLink"), function () { renderCloudLogin(root); }));
    form.appendChild(h("p.u-muted", { text: t("auth.localCaveat"), style: { marginBlockStart: "12px", fontSize: "0.78rem" } }));

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var res = PMS.auth.login(userInput.value, passInput.value);
      if (res.error) { setError(form, res.error); return; }
      root.innerHTML = "";
      enterApp(root);
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
      case "duplicateEmail": return t("auth.duplicateEmail");
      case "lastAdmin": return t("auth.lastAdmin");
      case "self": return t("auth.selfDelete");
      case "notfound": return t("auth.notFound");
      case "weak": return t("auth.weak");
      case "network": return t("auth.network");
      case "authNotEnabled": return t("auth.authNotEnabled");
      case "domainNotAllowed": return t("auth.domainNotAllowed");
      case "apiNotActivated": return t("auth.apiNotActivated");
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
    // Cloud-first, always: every visitor signs in with the shared account
    // (email + password created by the admin). Local screens are a defensive
    // fallback only for sites that have no cloud configuration at all.
    if (cloudAvailable()) renderCloudLogin(root);
    else if (!PMS.auth.configured()) renderLocalSetup(root);
    else renderLocalLogin(root);
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