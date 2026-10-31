"use strict";

// Presentation only: this result never authorizes a native financial operation.
// Callers bind it to one visible, current renderer before and after the review.
async function showRendererDialog({ dialog, parent, name, kind, input, signal, reviewable }) {
  if (!["confirm", "alert"].includes(kind) || !input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["message", "options"].includes(key))) throw Error("Invalid dialog request");
  const options = input.options ?? {};
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["title", "detail", ...(kind === "confirm" ? ["confirmLabel", "cancelLabel"] : ["buttonLabel"])].includes(key))) throw Error("Invalid dialog options");
  function text(value, fallback, limit) { if (value === undefined) return fallback; if (typeof value !== "string" || value.length > limit) throw Error("Dialog text is invalid or too long"); return value; }
  const message = text(input.message, "", 16000), detail = text(options.detail, "", 16000);
  if (!message.trim()) throw Error("A dialog message is required");
  const title = text(options.title, kind === "confirm" ? "Review action" : "Notice", 180);
  const buttons = kind === "confirm" ? [text(options.cancelLabel, "Cancel", 80), text(options.confirmLabel, "Continue", 80)] : [text(options.buttonLabel, "OK", 80)];
  if (buttons.some(label => !label.trim())) throw Error("Dialog buttons need labels");
  const cancelled = () => kind === "confirm" ? false : undefined;
  if (signal?.aborted || !reviewable()) return cancelled();
  const result = await dialog.showMessageBox(parent, { type: kind === "confirm" ? "question" : "info", title: name, message: title,
    detail: message + (detail ? "\n\n" + detail : ""), buttons, cancelId: 0, defaultId: 0, noLink: true, signal });
  if (signal?.aborted || !reviewable()) return cancelled();
  return kind === "confirm" ? result.response === 1 : undefined;
}
module.exports = { showRendererDialog };
