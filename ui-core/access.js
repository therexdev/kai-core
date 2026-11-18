"use strict";
(function () {
  const bridge = window.kaiCore, i18n = window.KaiI18n, byId = id => document.getElementById(id);
  let reading = false;
  const text = (element, value) => i18n.setText(element, value);
  async function refresh() {
    if (reading || bridge.isClosing()) return;
    reading = true; byId("access-refresh").disabled = true;
    try {
      const grants = await bridge.call("access.list"), list = byId("access-list");
      list.replaceChildren(); byId("access-empty").hidden = grants.length > 0;
      for (const grant of grants) {
        const row = document.createElement("li"), content = document.createElement("div"), name = document.createElement("strong"), detail = document.createElement("p"), publisher = document.createElement("p"), button = document.createElement("button");
        row.className = "access-grant"; detail.className = publisher.className = "muted";
        text(name, i18n.literal(grant.name));
        text(detail, i18n.message`Network credits · Allowed always · ${new Date(grant.grantedAt).toLocaleString(i18n.language)}`);
        publisher.className += " access-publisher";
        text(publisher, i18n.literal(grant.pluginId + " · " + grant.fingerprint));
        text(button, "Revoke access"); button.type = "button";
        button.setAttribute("aria-label", i18n.t("Revoke access") + ": " + grant.name);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await bridge.call("access.revoke", { id: grant.id }); text(byId("access-status"), "Access revoked. New requests require approval."); await refresh(); }
          catch (error) { text(byId("access-status"), i18n.message`Could not update access: ${error.message}`); button.disabled = false; }
        });
        content.append(name, detail, publisher); row.append(content, button); list.append(row);
      }
    } catch (error) { text(byId("access-status"), i18n.message`Could not load access: ${error.message}`); }
    finally { reading = false; byId("access-refresh").disabled = false; }
  }
  byId("access-refresh").addEventListener("click", () => { text(byId("access-status"), ""); void refresh(); });
  window.KaiCoreAccess = { enter: () => { text(byId("access-status"), ""); return refresh(); }, open: () => { byId("access-settings").scrollIntoView({ block: "start" }); byId("access-heading").focus(); } };
})();
