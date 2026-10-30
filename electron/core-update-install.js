"use strict";

// Called only after native services have stopped and the normal quit gate is open.
// electron-updater may emit an error instead of throwing when an installer fails.
function installAndQuit({ updater, app, dialog }) {
  let failed = false;
  const failure = () => {
    if (failed) return;
    failed = true;
    try { dialog.showErrorBox("KAI Core update could not start", "The installer could not start. KAI Core will close so it does not keep your profile locked. Open it again or install the new version using the manual download."); }
    finally { app.quit(); }
  };
  updater.once("error", failure);
  try { updater.quitAndInstall(); } catch { failure(); }
}

module.exports = { installAndQuit };
