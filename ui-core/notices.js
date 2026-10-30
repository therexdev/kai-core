"use strict";
(function (root) {
  // Dismissing a message never cancels or acknowledges the underlying operation.
  function create({ container, message, close, focusTarget }) {
    let current = "", dismissed = null;
    function show(value, { error = false, dismissible = true, force = false } = {}) {
      const content = String(value ?? "");
      const key = JSON.stringify([content, error, dismissible]);
      if (force || key !== current) dismissed = null;
      current = key;
      if (message.textContent !== content) message.textContent = content;
      container.classList.toggle("error", error);
      message.classList.toggle("error", error);
      close.hidden = !dismissible;
      container.hidden = !content || dismissed === current;
    }
    function dismiss() {
      if (close.hidden || container.hidden) return;
      const hadFocus = close.ownerDocument?.activeElement === close;
      dismissed = current; container.hidden = true;
      if (hadFocus) focusTarget?.()?.focus({ preventScroll: true });
    }
    close.onclick = dismiss;
    return { show, dismiss, clear() { show(""); } };
  }
  if (typeof module === "object" && module.exports) module.exports = { create };
  if (root) root.KaiCoreNotice = { create };
})(typeof window === "object" ? window : null);
