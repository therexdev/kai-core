"use strict";
const { ModelStorage } = require("../core/lib/model-storage");
const translations = require("../ui-core/locales/core.json");
function createModelStorageController({ core, dataDir, electron, getWindow, isClosing }) {
  const storage = new ModelStorage({ models: core.models, runtime: core.runtime, gateway: core.gateway, dataDir });
  const t = source => translations[core.locale.get().language]?.[source] || source;
  let choosing = false;
  return {
    status: () => storage.status(), cancel: () => storage.cancel(), dispose: () => storage.dispose(),
    async choose(kind, reviewable) {
      if (!["models", "custom"].includes(kind)) throw Error("Unknown model folder");
      if (choosing || storage.promise) throw Error("Wait for the current folder selection or transfer to finish");
      if (isClosing() || !reviewable()) return { cancelled: true };
      choosing = true;
      try {
        const current = storage.status();
        const choice = await electron.dialog.showOpenDialog(getWindow(), {
          title: t(kind === "models" ? "Choose downloaded model folder" : "Choose custom GGUF folder"),
          defaultPath: kind === "models" ? current.modelsDir : current.customDir || undefined,
          properties: ["openDirectory", "createDirectory"],
        });
        if (choice.canceled || !choice.filePaths[0] || isClosing() || !reviewable()) return { cancelled: true };
        const plan = storage.prepare(kind, choice.filePaths[0]);
        const detail = [t("Files are copied and verified before their saved locations change."),
          plan.from || plan.items.slice(0, 12).map(item => item.source).join("\n"),
          `${t("Destination")}: ${plan.target}`, `${t("Files")}: ${plan.items.length} · ${(plan.bytes / 1024 ** 3).toFixed(2)} GiB`,
          t(kind === "custom" ? "Future GGUF imports will be copied here. Their source files are always kept during import." : "Future catalog downloads will use this folder."),
          t("Local model requests pause during the transfer. Existing network work is allowed to finish.")].filter(Boolean).join("\n\n");
        const review = await electron.dialog.showMessageBox(getWindow(), {
          type: "question", title: t("Model storage"), message: t("Change model folder?"), detail,
          checkboxLabel: t("Remove original files after verification"), checkboxChecked: false,
          buttons: [t("Cancel"), t("Change folder")], defaultId: 0, cancelId: 0,
        });
        if (review.response !== 1 || isClosing() || !reviewable()) return { cancelled: true };
        return storage.start(plan, { deleteOriginals: review.checkboxChecked === true });
      } finally { choosing = false; }
    },
  };
}
module.exports = { createModelStorageController };
