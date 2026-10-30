"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events");
const { installAndQuit } = require("../../electron/core-update-install");

test("installer failure by event or throw releases the stopped application", async () => {
  for (const mode of ["event", "throw", "later"]) {
    const updater = new EventEmitter(); let quits = 0, notices = 0;
    updater.quitAndInstall = () => {
      if (mode === "throw") throw Error("Installer unavailable");
      if (mode === "event") updater.emit("error", Error("Installer unavailable"));
      else setImmediate(() => updater.emit("error", Error("Installer unavailable")));
    };
    installAndQuit({ updater, app: { quit() { quits++; } }, dialog: { showErrorBox() { notices++; } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 1, mode); assert.equal(notices, 1, mode);
  }
});

test("a successful installer retains control over exit and relaunch", () => {
  const updater = new EventEmitter(); let starts = 0, quits = 0;
  updater.quitAndInstall = () => { starts++; };
  installAndQuit({ updater, app: { quit() { quits++; } }, dialog: { showErrorBox() { assert.fail("unexpected failure"); } } });
  assert.equal(starts, 1); assert.equal(quits, 0);
});
