/* Account settings, isolated from general configuration and backup UI. */
(function (PMS) {
  "use strict";
  PMS.settingsAccounts = { create: function (options) {
  var h = PMS.dom.h;
  var t = function (k, v) { return PMS.i18n.t(k, v); };
  var render = options.render;
  var cloudReady = options.cloudReady;
  /* ---------------- Accounts ---------------- */
  function renderAccounts(body) {
    var card = h("div.card");
    card.appendChild(h("div.card-header", [
      h("div.u-grow.card-title", { text: t("auth.accounts") }),
      cloudReady() ? h("button.btn.btn-primary.btn-sm", { text: "+ " + t("auth.addCloudAccount"), on: { click: function () { addCloudAccount(); } } })
                   : h("button.btn.btn-primary.btn-sm", { text: "+ " + t("auth.addAccount"), on: { click: function () { editAccount(null); } } })
    ]));
    var b = h("div.card-body");
    b.appendChild(h("p.u-muted", { text: t("auth.accountsHint"), style: { marginBlockEnd: "8px" } }));
    var list = PMS.auth.users();
    if (!list.length) b.appendChild(h("div.u-muted", { text: t("common.noResults") }));
    list.forEach(function (u) {
      var row = h("div.account-row");
      row.appendChild(PMS.vformat.avatar({ id: u.id, name: PMS.authUI.displayName(u) }));

      var main = h("div.ar-main");
      var nameLine = h("div.ar-name", [
        h("span.u-ellipsis", { text: PMS.authUI.displayName(u) }),
        h("span.role-badge." + u.role, { text: t("auth.role." + u.role) })
      ]);
      if (PMS.auth.currentUser() && PMS.auth.currentUser().id === u.id) {
        nameLine.appendChild(h("span.chip", { text: t("auth.you") }));
      }
      if (u.cloudUid) nameLine.appendChild(h("span.chip", { text: t("auth.cloudBadge") }));
      if (u.active === false) nameLine.appendChild(h("span.chip", { text: t("auth.inactiveFlag") }));
      main.appendChild(nameLine);
      var metaLine = h("div.ar-meta");
      metaLine.appendChild(h("span", { text: "@" + u.username }));
      if (u.personId) {
        var p = PMS.repos.people.get(u.personId);
        if (p) {
          var pd = PMS.repos.departments.get(p.departmentId);
          if (pd) metaLine.appendChild(h("span", { text: " · " + PMS.i18n.trilingual(pd.name)(pd.name) }));
        }
      }
      if (u.lastLoginAt) metaLine.appendChild(h("span", { text: " · " + t("auth.lastLogin") + ": " + PMS.utils.formatDate(u.lastLoginAt, PMS.i18n) }));
      main.appendChild(metaLine);
      row.appendChild(main);

      // active toggle
      var toggle = h("label.switch", { attrs: { title: t("auth.activeToggle") } });
      var chk = h("input", { type: "checkbox", checked: u.active !== false, on: { change: function (e) {
        var res = PMS.auth.updateUser(u.id, { active: e.target.checked });
        if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); render(document.getElementById("view-root")); return; }
        PMS.store.flush();
      } } });
      toggle.appendChild(chk);
      toggle.appendChild(h("span.slider"));
      row.appendChild(toggle);

      row.appendChild(h("button.btn.btn-sm.btn-ghost", { text: t("common.edit"), on: { click: function () { editAccount(u); } } }));
      row.appendChild(h("button.btn.btn-sm.btn-icon", { text: "🔑", attrs: { title: t("auth.resetPassword") }, on: { click: function () { if (u.cloudUid) cloudResetPassword(u); else resetPasswordAccount(u); } } }));
      row.appendChild(h("button.btn.btn-sm.btn-icon.btn-soft-danger", { text: "✕", attrs: { title: t("common.delete") }, on: { click: function () { if (u.cloudUid) deleteCloudAccount(u); else deleteAccount(u); } } }));
      b.appendChild(row);
    });
    if (list.some(function (x) { return x.cloudUid; })) {
      b.appendChild(h("p.u-muted", { text: t("auth.cloudAccountsNote"), style: { marginBlockStart: "10px", fontSize: "0.78rem" } }));
    }
    card.appendChild(b);
    body.appendChild(card);
  }

  function accountOptions() {
    return PMS.auth.roles.map(function (r) { return { label: PMS.i18n.t("auth.role." + r), value: r }; });
  }

  function editAccount(user) {
    var isEdit = !!user;
    var people = PMS.repos.people.all().filter(function (p) { return p.status !== "inactive"; });
    var personOptions = [{ label: t("auth.noPerson"), value: "" }].concat(people.map(function (p) { return { label: p.name, value: p.id }; }));
    var fields = [
      { key: "personId", label: t("auth.linkPerson"), type: "select", options: personOptions },
      { key: "username", label: isEdit && user.cloudUid ? t("auth.cloudEmail") : t("auth.username"), type: "text", required: true },
      { key: "role", label: t("auth.roleLabel"), type: "select", options: accountOptions() }
    ];
    if (!isEdit) {
      fields.push({ key: "password", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true });
      fields.push({ key: "confirm", label: t("auth.confirmPassword"), type: "password", required: true });
    }
    PMS.modal.open({
      title: isEdit ? t("common.edit") + " " + t("auth.account") : t("auth.addAccount"),
      size: "sm",
      content: function () {
        var form = PMS.forms.build(fields, {
          personId: user ? user.personId || "" : "",
          username: user ? user.username : "",
          role: user ? user.role : "member"
        });
        if (isEdit && user.cloudUid) {
          var noteText = t("auth.cloudEmailNote");
          if (PMS.cloudsync && PMS.cloudsync.backendAvailable && PMS.cloudsync.backendAvailable() === false) {
            noteText = t("auth.emailNotSynced");
          }
          form.appendChild(h("p.u-muted", { text: noteText, style: { marginBlockStart: "8px", fontSize: "0.78rem" } }));
        }
        return form;
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (!isEdit && v.password !== v.confirm) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            var res;
            if (isEdit) res = PMS.auth.updateUser(user.id, { username: v.username, role: v.role, personId: v.personId || null });
            else res = PMS.auth.createUser({ username: v.username, password: v.password, role: v.role, personId: v.personId || null });
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            // reverse-sync: keep the linked person's email in lockstep with the
            // account's sign-in email (person e-mail is the profile of record).
            if (isEdit && v.username && v.personId && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.username) && PMS.repos && PMS.repos.people) {
              var lp = PMS.repos.people.get(v.personId);
              if (lp && String(lp.email || "").trim().toLowerCase() !== v.username.toLowerCase()) {
                PMS.repos.people.update(lp.id, { email: v.username });
              }
            }
            // keep the shared cloud role + linked person in sync so other
            // devices see them (personId is what authorizes per-record writes)
            if (isEdit && user.cloudUid) {
              if (PMS.cloudsync && PMS.cloudsync.setCloudRole) PMS.cloudsync.setCloudRole(user.cloudUid, v.role);
              if (PMS.cloudsync && PMS.cloudsync.setCloudPersonId) PMS.cloudsync.setCloudPersonId(user.cloudUid, v.personId || null);
              // the sign-in email lives in Firebase Authentication; only the
              // trusted adminUpdateEmail callable may change it. On failure
              // revert the local mirror so the list never shows an email that
              // Firebase still rejects.
              if (PMS.cloudsync && PMS.cloudsync.setCloudEmail && v.username !== user.username) {
                PMS.cloudsync.setCloudEmail(user.cloudUid, v.username).catch(function (err) {
                  PMS.auth.updateUser(user.id, { username: user.username });
                  // undo the person-email mirror too so the profile stays in
                  // lockstep with the (still valid) sign-in email — never leave
                  // a half-applied change behind on a failed cloud update
                  if (v.personId && PMS.repos && PMS.repos.people) {
                    var lp2 = PMS.repos.people.get(v.personId);
                    if (lp2 && String(lp2.email || "").trim().toLowerCase() !== String(user.username || "").trim().toLowerCase()) {
                      PMS.repos.people.update(lp2.id, { email: user.username });
                    }
                  }
                  PMS.store.flush();
                  render(document.getElementById("view-root"));
                  var msg = (err && err.userCode === "backendRequired")
                    ? t("auth.emailNotSynced")
                    : (err && /already-exists|email-already-in-use/.test(err.code || err.userCode || ""))
                      ? t("auth.emailInUse")
                      : PMS.authUI.errorMessage("generic");
                  PMS.toast.show(msg, "error");
                });
              }
            }
            PMS.modal.close();
            PMS.store.flush();
            render(document.getElementById("view-root"));
          }
        }
      ]
    });
  }

  function addCloudAccount() {
    var people = PMS.repos.people.all().filter(function (p) { return p.status !== "inactive"; });
    var personOptions = [{ label: t("auth.noPerson"), value: "" }].concat(people.map(function (p) { return { label: p.name, value: p.id }; }));
    PMS.modal.open({
      title: t("auth.addCloudAccount"),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "personId", label: t("auth.linkPerson"), type: "select", options: personOptions },
          { key: "email", label: t("auth.cloudEmail"), type: "text", required: true },
          { key: "name", label: t("auth.name"), type: "text" },
          { key: "password", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true },
          { key: "confirm", label: t("auth.confirmPassword"), type: "password", required: true }
        ], {});
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.save"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (v.password !== v.confirm) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            if (!PMS.cloudsync || !PMS.cloudsync.signUpWithPassword) return;
            PMS.cloudsync.signUpWithPassword({
              email: v.email, password: v.password, name: v.name || "", personId: v.personId || null
            }).then(function (res) {
              PMS.cloudBridge.register({ username: res.email, cloudUid: res.uid, role: res.role, name: res.displayName || v.name || "", personId: res.personId || null });
              PMS.modal.close();
              PMS.store.flush();
              PMS.toast.show(t("auth.cloudAccountCreated"), "success");
              render(document.getElementById("view-root"));
            }).catch(function (err) {
              PMS.toast.show(PMS.authUI.errorMessage((err && err.userCode) || "generic"), "error");
              console.error("[zms] create cloud account failed:", err && err.code || err, err);
            });
          }
        }
      ]
    });
  }

  function resetPasswordAccount(user) {
    PMS.modal.open({
      title: t("auth.resetPassword") + " — " + (user.username || ""),
      size: "sm",
      content: function () {
        return PMS.forms.build([
          { key: "pw", label: t("auth.password") + " (" + t("auth.pwHint") + ")", type: "password", required: true },
          { key: "pw2", label: t("auth.confirmPassword"), type: "password", required: true }
        ], {});
      },
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("auth.resetPassword"), class: "btn-primary",
          onClick: function (_, body) {
            var v = body.querySelector("form")._getValues();
            if (v.pw !== v.pw2) { PMS.toast.show(t("auth.mismatch"), "error"); return; }
            var res = PMS.auth.resetPassword(user.id, v.pw);
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            PMS.modal.close();
            PMS.toast.show(t("auth.passwordReset"), "success");
            PMS.store.flush();
          }
        }
      ]
    });
  }

  function cloudResetPassword(user) {
    PMS.modal.open({
      title: t("auth.resetPassword") + " — " + (user.username || ""),
      size: "sm",
      content: h("p", { text: t("auth.cloudResetConfirm", { email: user.username }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("auth.cloudReset"), class: "btn-primary",
          onClick: function () {
            if (!PMS.cloudsync || !PMS.cloudsync.resetPassword) return;
            PMS.cloudsync.resetPassword(user.username).then(function () {
              PMS.modal.close();
              PMS.toast.show(t("auth.cloudResetSent"), "success");
            }).catch(function () {
              PMS.modal.close();
              PMS.toast.show(t("auth.network"), "error");
            });
          }
        }
      ]
    });
  }

  function deleteAccount(user) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("auth.deleteAccount"),
      content: h("p", { text: t("auth.deleteAccountConfirm", { name: user.username }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.delete"), class: "btn-danger",
          onClick: function () {
            var res = PMS.auth.removeUser(user.id);
            if (res.error) { PMS.toast.show(PMS.authUI.errorMessage(res.error), "error"); return; }
            PMS.modal.close();
            PMS.store.flush();
            render(document.getElementById("view-root"));
          }
        }
      ]
    });
  }

  // ZMS-R05: cloud account deletion goes through the trusted backend callable
  // only — there is deliberately NO direct-browser fallback for this one.
  function deleteCloudAccount(user) {
    if (PMS.auth.requireDelete && !PMS.auth.requireDelete()) return;
    PMS.modal.open({
      title: t("auth.deleteAccount"),
      content: h("p", { text: t("auth.cloudDeleteConfirm", { name: user.username }) }),
      footer: [
        { label: t("common.cancel"), onClick: function () { PMS.modal.close(); } },
        {
          label: t("common.delete"), class: "btn-danger",
          onClick: function () {
            var p = (PMS.cloudsync && PMS.cloudsync.deleteCloudAccount)
              ? PMS.cloudsync.deleteCloudAccount(user.cloudUid)
              : Promise.reject({ userCode: "backendRequired" });
            p.then(function () {
              if (PMS.auth && PMS.auth.removeUser) PMS.auth.removeUser(user.id);
              PMS.modal.close();
              PMS.store.flush();
              render(document.getElementById("view-root"));
            }).catch(function (err) {
              PMS.modal.close();
              PMS.toast.show((err && err.userCode) === "backendRequired"
                ? t("auth.backendRequired")
                : PMS.authUI.errorMessage("generic"), "error");
            });
          }
        }
      ]
    });
  }

  return renderAccounts;
  } };
})(window.PMS);
