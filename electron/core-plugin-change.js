"use strict";

async function changePlugin({ manager, host, payments, appOrder, features, dialog, parent, reviewable }, { id, action } = {}) {
  const plugin = manager.list().find(row => row.id === id);
  if (!plugin || !["enable", "disable", "rollback", "remove"].includes(action)) throw Error("Invalid plugin action");
  if (action === "remove") {
    if (!reviewable()) return manager.list();
    const marker = JSON.stringify(manager.state.installed[id]);
    const answer = await dialog.showMessageBox(parent, {
      type: "warning", title: "Remove plugin and data", message: plugin.name,
      detail: "Permanently delete this plugin's installation folder, all installed versions, saved files, settings and local credit history? Plugin-specific wallets, keys and backups inside that folder will also be deleted. This cannot be undone. Back up anything you need first.\n\nTo keep your files and settings, choose Disable instead. Disabling stops the plugin and removes it from the Apps menu. You can enable it again later.\n\nShared Core wallets and models are kept. Files exported or stored in custom folders outside the plugin folder are not deleted by Core.",
      buttons: plugin.removing ? ["Cancel", "Retry removal"] : ["Cancel", "Disable instead", "Remove plugin and data"], defaultId: 0, cancelId: 0,
    });
    if (!reviewable() || answer.response === 0 || answer.response === -1) return manager.list();
    if (JSON.stringify(manager.state.installed[id]) !== marker) throw Error("Plugin changed. Review removal again");
    if (!plugin.removing && answer.response === 1) action = "disable";
    else if (answer.response !== (plugin.removing ? 1 : 2)) return manager.list();
  }
  if (action === "remove") {
    const installed = await manager.remove(id, async () => {
      await host.close(id, "remove");
      await payments.removePluginData(id, plugin.fingerprint);
      // Save the sidebar preference while removal is still retryable.
      appOrder.save(appOrder.read().filter(item => item !== id));
    });
    return installed;
  }
  if (plugin.removing) throw Error("Removal is incomplete. Retry Remove to finish deleting this plugin");
  // Revoke before yielding so another window cannot reopen a stopping service.
  if (action === "disable") manager.change(id, "disable");
  await host.close(id, action);
  const installed = action === "disable" ? manager.list() : manager.change(id, action);
  if (["enable", "rollback"].includes(action)) void features.startInstalledBackground(manager, id).catch(error => console.warn("[plugin-startup]", error.message));
  return installed;
}
module.exports = { changePlugin };
