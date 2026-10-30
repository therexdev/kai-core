"use strict";

const fs = require("node:fs"), path = require("node:path");

// Only a working notification-area icon may turn the main window's X into Hide.
// This module never stops the provider or closes plugin services on a normal X.
function createCoreTray({ app, win, Tray, Menu, nativeImage, iconDirectory, isQuitting, logger = console, platform = process.platform }) {
  let tray = null, disposed = false, quitRequested = false;
  const quitting = () => quitRequested || isQuitting();
  const available = () => !disposed && !!tray && !tray.isDestroyed();
  function show() {
    if (disposed || quitting() || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
  }
  function destroyTray() {
    const previous = tray; tray = null;
    if (previous && !previous.isDestroyed()) previous.destroy();
  }
  function quit() {
    if (disposed || quitting()) return;
    quitRequested = true;
    // Core's before-quit handler awaits native services before exiting.
    app.quit();
  }
  try {
    let iconPath = path.join(iconDirectory, platform === "win32" ? "icon.ico" : "icon.png");
    const unpacked = iconPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    if (unpacked !== iconPath && fs.existsSync(unpacked)) iconPath = unpacked;
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) throw Error("KAI Core tray icon is unavailable");
    if (platform !== "win32") image = image.resize({ width: 22, height: 22 });
    if (platform === "darwin") image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip("KAI Core");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open KAI Core", click: show },
      { type: "separator" },
      { label: "Quit KAI Core", click: quit },
    ]));
    tray.on("click", show); tray.on("double-click", show);
  } catch (error) {
    destroyTray();
    logger.warn("[tray] Closing the window will quit because the tray is unavailable:", error.message);
  }
  function close(event) {
    if (disposed || quitting() || !available()) return;
    event.preventDefault();
    try { win.hide(); }
    catch (error) {
      // Keep a failed Hide from making the window impossible to close later.
      destroyTray();
      logger.warn("[tray] The window could not be hidden; closing will quit:", error.message);
    }
  }
  function closed() {
    const alreadyQuitting = quitting();
    dispose();
    // Optional plugin windows must not strand Core after its main window closes.
    if (!alreadyQuitting) { quitRequested = true; app.quit(); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    app.removeListener("activate", show);
    win.removeListener("close", close); win.removeListener("closed", closed); win.removeListener("session-end", quit);
    destroyTray();
  }
  app.on("activate", show);
  win.on("close", close); win.on("closed", closed);
  // Windows does not emit before-quit for every shutdown/logoff path. Begin
  // normal teardown on the final session-end event without delaying the OS.
  win.on("session-end", quit);
  return { get available() { return available(); }, show, dispose };
}

module.exports = { createCoreTray };
