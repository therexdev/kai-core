"use strict";

// Called only after native services have stopped and the normal quit gate is open.
// electron-updater may emit an error instead of throwing when an installer fails.
function installAndQuit({ updater, app, dialog }) {
  let failed = false;
  const failure = async () => {
    if (failed) return;
    failed = true;
    try { await dialog.showErrorBox("KAI Core Beta update could not start", "The installer could not start. KAI Core Beta will close so it does not keep your profile locked. Open it again or install the new version using the manual download."); }
    catch { /* Failure to display a notice must still release the stopped app. */ }
    finally { app.quit(); }
  };
  updater.once("error", failure);
  try { Promise.resolve(updater.quitAndInstall()).catch(failure); } catch { failure(); }
}

module.exports = { installAndQuit };
