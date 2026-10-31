"use strict";
(function (root) {
  const decimal = /^(0|[1-9]\d{0,11})(\.\d{1,8})?$/, atomsPattern = /^(0|[1-9]\d{0,19})$/, hashPattern = /^0x1220[a-f0-9]{64}$/;
  const MAX = 18446744073709551615n;
  const issue = error => String(error?.message || error || "Wallet data is unavailable").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").slice(0, 400);
  function amount(value) {
    if (typeof value !== "string" || !decimal.test(value)) return "—";
    const [whole, fraction = ""] = value.split("."), tail = fraction.replace(/0+$/, "");
    return BigInt(whole).toLocaleString() + (tail ? new Intl.NumberFormat().formatToParts(1.1).find(p => p.type === "decimal").value + tail : "");
  }
  function atomAmount(value) { const n = BigInt(value); return amount(`${n / 100000000n}.${(n % 100000000n).toString().padStart(8, "0")}`); }
  function validAmount(value) {
    if (typeof value !== "string" || !decimal.test(value)) return false;
    const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 100000000n + BigInt(fraction.padEnd(8, "0")) <= MAX;
  }
  function validateSummary(value, address, now) {
    if (!value || value.address !== address || !["mainnet", "harbinger"].includes(value.network) || value.tokenSymbol !== (value.network === "mainnet" ? "KOIN" : "tKOIN") || !Number.isSafeInteger(value.observedAt) || value.observedAt > now + 5000 || value.observedAt < now - 60000 || !validAmount(value.koin) || [value.vhp, value.mana].some(v => v !== null && !validAmount(v))) throw Error("Wallet balance did not match the current wallet and network.");
    return structuredClone(value);
  }
  function validateHistory(value, summary, now) {
    if (!value || !summary || value.address !== summary.address || value.network !== summary.network || value.tokenSymbol !== summary.tokenSymbol || value.available !== true || !Array.isArray(value.rows) || value.rows.length > 50 || !Number.isSafeInteger(value.observedAt) || value.observedAt > now + 5000 || value.observedAt < now - 60000 || value.nextCursor != null && (typeof value.nextCursor !== "string" || value.nextCursor.length > 4096)) throw Error("Wallet history did not match the current wallet and network.");
    for (const row of value.rows) {
      if (!row || !["transaction", "block"].includes(row.kind) || !hashPattern.test(row.id) || typeof row.label !== "string" || row.label.length > 180 || !["confirmed", "confirming", "failed"].includes(row.status) || row.timestamp !== null && (!Number.isSafeInteger(row.timestamp) || row.timestamp < 0 || row.timestamp > now + 300000) || row.height !== null && (typeof row.height !== "string" || !atomsPattern.test(row.height)) || row.counterparty !== null && (typeof row.counterparty !== "string" || row.counterparty.length > 120) || !Array.isArray(row.changes) || row.changes.length > 1024) throw Error("Wallet history contained an invalid transaction.");
      for (const change of row.changes) if (!change || ![summary.tokenSymbol, "VHP"].includes(change.asset) || !["in", "out"].includes(change.direction) || typeof change.amount !== "string" || !atomsPattern.test(change.amount) || BigInt(change.amount) > MAX) throw Error("Wallet history contained an invalid amount.");
    }
    return structuredClone(value);
  }
  function createController({ call, render = () => {}, clearSecrets = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const state = { active: false, wallet: null, privacyMode: "local-only", summary: null, rows: [], cursor: null, historyObserved: null, expanded: false, loading: false, busy: false, balanceError: "", historyError: "", notice: "", noticeError: false, noticeVersion: 0, readVersion: 0 };
    let generation = 0, secretGeneration = 0, pending = null, timer = null;
    const fresh = () => state.summary && !state.balanceError && now() - state.summary.observedAt < 60000 && state.summary.observedAt <= now() + 5000;
    const paint = () => render(state, { fresh: !!fresh(), canSend: !!(state.wallet?.unlocked && fresh() && !state.busy) });
    function secrets() { secretGeneration++; clearSecrets(); }
    function stop() { generation++; pending = null; state.loading = false; clearTimer(timer); timer = null; }
    function reset() { state.summary = null; state.rows = []; state.cursor = null; state.historyObserved = null; state.expanded = false; state.balanceError = ""; state.historyError = ""; }
    function notice(message, error = false) { state.notice = message; state.noticeError = error; state.noticeVersion++; paint(); }
    function observe(wallet, privacyMode) {
      const previous = state.wallet, next = { exists: wallet?.exists === true, address: wallet?.address || null, unlocked: wallet?.unlocked === true };
      const changed = previous?.address !== next.address;
      if (changed) { stop(); reset(); secrets(); state.notice = ""; }
      else if (previous?.unlocked && !next.unlocked) { secrets(); state.notice = ""; }
      state.wallet = next; state.privacyMode = privacyMode;
      paint(); if (changed && state.active) void refresh();
    }
    async function refresh(older = false, automatic = false) {
      if (!state.active || !state.wallet?.address || older && !state.cursor) { paint(); return; }
      if (pending) return pending;
      const version = generation, address = state.wallet.address, current = () => state.active && version === generation && address === state.wallet?.address;
      clearTimer(timer); state.loading = true; if (!automatic) state.readVersion++; paint();
      const task = (async () => {
        let deadline;
        const read = (method, input) => Promise.race([Promise.resolve().then(() => call(method, input)), new Promise((_, reject) => { deadline = setTimer(() => reject(Error("Wallet update timed out. Try again.")), 20000); })]).finally(() => clearTimer(deadline));
        if (!older) {
          try {
            const result = await read("wallet.summary", {}); if (!current()) return;
            const summary = validateSummary(result, address, now());
            if (state.summary && state.summary.network !== summary.network) { reset(); secrets(); }
            state.summary = summary; state.balanceError = ""; paint();
          } catch (error) { if (!current()) return; state.balanceError = issue(error); }
        }
        if (!current()) return;
        if (state.summary && !state.balanceError && !(automatic && state.expanded)) {
          try {
            const result = await read("wallet.history", older ? { cursor: state.cursor } : {}); if (!current()) return;
            const history = validateHistory(result, state.summary, now());
            state.rows = older ? [...new Map([...state.rows, ...history.rows].map(row => [row.kind + ":" + row.id, row])).values()] : history.rows;
            state.cursor = history.nextCursor; state.historyObserved = history.observedAt; state.expanded = older; state.historyError = "";
          } catch (error) { if (!current()) return; state.historyError = issue(error); }
        }
        if (current()) paint();
      })();
      pending = task;
      try { await task; } finally {
        if (pending === task) pending = null;
        if (current()) { state.loading = false; paint(); timer = setTimer(() => void refresh(false, true), 30000); }
      }
    }
    async function perform(method, input = {}) {
      if (state.busy || !state.active || !state.wallet?.address) return null;
      const isReveal = method === "wallet.reveal", isSend = method === "wallet.send", isMaximum = method === "wallet.maxSend";
      if ((isReveal || isSend || isMaximum) && !state.wallet.unlocked) { notice("Unlock your wallet to continue.", true); return null; }
      if ((isSend || isMaximum) && !fresh()) { notice("Refresh your wallet balance before sending.", true); return null; }
      const version = generation, secretVersion = secretGeneration, address = state.wallet.address;
      const current = () => state.active && generation === version && state.wallet?.address === address && (!isReveal || secretVersion === secretGeneration && state.wallet.unlocked);
      const payload = { ...input, expectedAddress: address, ...(["wallet.send", "wallet.maxSend", "wallet.openExplorer"].includes(method) ? { expectedNetwork: state.summary?.network } : {}) };
      state.busy = true; notice(isSend ? "Review the exact transfer in the approval window." : "", false);
      try {
        const result = await call(method, payload); if (!current()) return null;
        if (isMaximum && (!state.wallet.unlocked || result?.address !== address || result?.network !== payload.expectedNetwork || state.summary?.network !== payload.expectedNetwork || result?.token !== input.token || !validAmount(result?.amount) || !Number.isSafeInteger(result?.observedAt) || now() - result.observedAt > 30000 || result.observedAt > now() + 5000)) throw Error("The available amount changed. Check the wallet and try Send All again.");
        if (isSend) {
          notice(result?.state === "cancelled" ? "Transfer cancelled. No transaction was submitted." : result?.state === "submitted" ? `${result.confirmed === true ? "Confirmed" : "Submitted; confirmation pending"}. Transaction ${result.txId || "pending"}. Check history for updates.` : "The transfer result could not be verified. Check history before trying again.", !["cancelled", "submitted"].includes(result?.state));
          if (result?.state === "submitted") void refresh();
        } else if (method === "wallet.copyAddress") notice("Address copied — share it to receive KOIN or VHP.");
        return result;
      } catch (error) { if (current()) notice(issue(error), true); return null; }
      finally { state.busy = false; if (state.active) paint(); }
    }
    return { observe, refresh, perform, clearSecrets: secrets, notice,
      enter() { if (state.active) return; state.active = true; paint(); void refresh(); },
      leave() { state.active = false; stop(); secrets(); state.notice = ""; paint(); },
      snapshot: () => structuredClone(state)
    };
  }
  function mount() {
    const document = root.document, $ = id => document.getElementById(id), page = document.querySelector('[data-panel="wallet"]');
    if (!page) return;
    let lastNotice = -1, lastRead = -1, historyMarkup = "", sendRevision = 0, sendIdentity = null;
    const notice = root.KaiCoreNotice.create({ container: $("wallet-notice"), message: $("wallet-message"), close: $("wallet-message-close"), focusTarget: () => $("wallet-refresh") });
    const balanceNotice = root.KaiCoreNotice.create({ container: $("wallet-balance-error"), message: $("wallet-balance-error-text"), close: $("wallet-balance-error-close"), focusTarget: () => $("wallet-refresh") });
    const historyNotice = root.KaiCoreNotice.create({ container: $("wallet-history-error"), message: $("wallet-history-error-text"), close: $("wallet-history-error-close"), focusTarget: () => $("wallet-history-refresh") });
    const text = (id, value) => { if ($(id).textContent !== String(value ?? "")) $(id).textContent = value ?? ""; };
    function clearSecrets() {
      for (const id of ["password", "restore-wif", "wallet-send-password", "wallet-reveal-password"]) $(id).value = "";
      text("wallet-backup", ""); $("wallet-backup").hidden = true; $("hide-backup").hidden = true;
    }
    function paintHistory(state) {
      const signature = JSON.stringify([state.summary?.network, state.rows]); if (signature === historyMarkup) return;
      historyMarkup = signature; const host = $("wallet-history-rows"), rows = [];
      for (const entry of state.rows) {
        const tr = document.createElement("tr"), activity = document.createElement("td"), value = document.createElement("td"), when = document.createElement("td"), status = document.createElement("td");
        const title = document.createElement("strong"); title.textContent = entry.label; activity.append(title);
        const ref = document.createElement(state.summary?.network === "mainnet" && entry.kind === "transaction" ? "button" : "small");
        ref.textContent = entry.kind === "block" ? "Block " + (entry.height || "") : entry.id;
        if (ref.tagName === "BUTTON") { ref.type = "button"; ref.className = "wallet-transaction-link"; ref.onclick = () => void controller.perform("wallet.openExplorer", { txId: entry.id }); }
        activity.append(ref);
        if (entry.counterparty) { const counterparty = document.createElement("small"); counterparty.textContent = entry.counterparty; activity.append(counterparty); }
        for (const change of entry.changes) { const line = document.createElement("div"); line.textContent = `${change.direction === "in" ? "+" : "−"}${atomAmount(change.amount)} ${change.asset}`; line.className = "payment-wallet-" + change.direction; value.append(line); }
        if (!entry.changes.length) value.textContent = "—";
        when.textContent = entry.timestamp == null ? "Time unavailable" : new Date(entry.timestamp).toLocaleString();
        status.textContent = ({ confirmed: "Confirmed", confirming: "Confirming", failed: "Failed" })[entry.status]; status.dataset.status = entry.status;
        tr.append(activity, value, when, status); rows.push(tr);
      }
      host.replaceChildren(...rows);
    }
    function render(state, view) {
      const wallet = state.wallet, summary = state.summary;
      $("wallet-account").hidden = !wallet?.address; $("wallet-access").hidden = !!wallet?.unlocked; $("wallet-unlocked").hidden = !wallet?.unlocked;
      text("wallet-access-title", wallet?.exists ? "Unlock your wallet" : "Create a wallet");
      text("wallet-detail", wallet?.exists ? "You can view balances and history while locked. Unlock to send or back up your wallet." : "Your private key is generated locally and encrypted with your password on this computer.");
      text("wallet-lock-state", wallet?.unlocked ? "Unlocked" : "Locked");
      text("wallet-network", summary ? `${summary.network === "mainnet" ? "Mainnet" : "Harbinger testnet"} · Share this address to receive ${summary.tokenSymbol} or VHP.` : "Share this address to receive KOIN or VHP.");
      text("wallet-koin-label", `${summary?.tokenSymbol || "KOIN"} (liquid)`);
      for (const name of ["koin", "vhp", "mana"]) text("wallet-" + name, amount(summary?.[name]));
      text("wallet-balance-note", state.balanceError ? summary ? `Previously checked balances from ${new Date(summary.observedAt).toLocaleTimeString()}. Refresh to check the current amounts.` : "Balances unavailable. Refresh to try again." : summary ? `Balances checked ${new Date(summary.observedAt).toLocaleTimeString()}. Mana is a resource balance, not a separate token.` : "Checking balances…");
      text("wallet-history-status", state.historyError ? state.rows.length ? "Showing previously loaded history. Refresh to check for updates." : "Transaction history unavailable. Try again to check for updates." : state.historyObserved ? state.rows.length ? `On-chain activity · checked ${new Date(state.historyObserved).toLocaleTimeString()}. Confirming transactions can still change.` : state.cursor ? "No transfers in this page. Load older transactions to continue." : "No transactions were found for this wallet on this network." : state.balanceError ? "Refresh wallet balances to load transaction history." : "Loading transaction history…");
      $("wallet-refresh").disabled = state.loading;
      $("wallet-history-refresh").hidden = !state.historyError && !state.expanded; $("wallet-history-refresh").disabled = state.loading; text("wallet-history-refresh", state.expanded && !state.historyError ? "Back to latest" : "Try again");
      $("wallet-history-more").hidden = !state.cursor; $("wallet-history-more").disabled = state.loading;
      $("wallet-copy").disabled = !wallet?.address || state.busy; $("wallet-explorer").hidden = summary?.network !== "mainnet"; $("wallet-explorer").disabled = state.busy;
      $("wallet-open-send").disabled = !view.canSend; $("wallet-send-submit").disabled = !view.canSend; $("wallet-reveal-submit").disabled = state.busy || !wallet?.unlocked;
      $("wallet-send-all").disabled = !view.canSend;
      for (const id of ["wallet-send-token", "wallet-send-to", "wallet-send-amount", "wallet-send-password", "wallet-send-close", "wallet-send-cancel"]) $(id).disabled = state.busy;
      if ($("wallet-send-panel").open && (!wallet?.unlocked || sendIdentity !== JSON.stringify([wallet.address, summary?.network]))) $("wallet-send-panel").close();
      text("wallet-send-message", state.notice); $("wallet-send-message").hidden = !state.notice; $("wallet-send-message").classList.toggle("error", state.noticeError);
      $("wallet-send-token").options[0].textContent = summary?.tokenSymbol || "KOIN";
      paintHistory(state);
      balanceNotice.show(state.balanceError, { error: true, force: state.readVersion !== lastRead });
      historyNotice.show(state.historyError, { error: true, force: state.readVersion !== lastRead }); lastRead = state.readVersion;
      notice.show(state.notice, { error: state.noticeError, force: state.noticeVersion !== lastNotice }); lastNotice = state.noticeVersion;
    }
    const controller = createController({ call: (method, input) => root.kaiCore.call(method, input), render, clearSecrets });
    $("wallet-copy").onclick = () => void controller.perform("wallet.copyAddress");
    $("wallet-explorer").onclick = () => void controller.perform("wallet.openExplorer");
    $("wallet-refresh").onclick = $("wallet-history-refresh").onclick = () => void controller.refresh();
    $("wallet-history-more").onclick = () => void controller.refresh(true);
    $("wallet-open-send").onclick = () => {
      if ($("wallet-open-send").disabled) return;
      const state = controller.snapshot(); sendIdentity = JSON.stringify([state.wallet.address, state.summary.network]); controller.notice("");
      $("wallet-send-panel").showModal(); $("wallet-send-to").focus({ preventScroll: true });
    };
    $("wallet-send-close").onclick = $("wallet-send-cancel").onclick = () => { if (!controller.snapshot().busy) $("wallet-send-panel").close(); };
    $("wallet-send-panel").addEventListener("cancel", event => { if (controller.snapshot().busy) event.preventDefault(); });
    $("wallet-send-panel").addEventListener("close", () => {
      ++sendRevision; sendIdentity = null; $("wallet-send-form").reset(); controller.clearSecrets();
      if (!page.hidden) $("wallet-open-send").focus({ preventScroll: true });
    });
    $("wallet-send-token").onchange = () => { ++sendRevision; $("wallet-send-amount").value = ""; controller.notice(""); };
    $("wallet-send-amount").oninput = () => { ++sendRevision; };
    $("wallet-send-all").onclick = async () => {
      const revision = ++sendRevision, token = $("wallet-send-token").value;
      const result = await controller.perform("wallet.maxSend", { token });
      if (!result || revision !== sendRevision || !$("wallet-send-panel").open || token !== $("wallet-send-token").value) return;
      $("wallet-send-amount").value = result.amount;
      controller.notice(result.amount === "0" ? "No tokens are available to send right now." : result.manaLimited ? "Filled the amount available with your current mana, leaving room for the transaction’s resource cost." : "");
    };
    $("wallet-reveal-panel").addEventListener("toggle", () => { if (!$("wallet-reveal-panel").open) controller.clearSecrets(); });
    $("wallet-send-form").onsubmit = async event => {
      event.preventDefault();
      const input = { token: $("wallet-send-token").value, to: $("wallet-send-to").value.trim(), amount: $("wallet-send-amount").value.trim(), password: $("wallet-send-password").value };
      $("wallet-send-password").value = "";
      const result = await controller.perform("wallet.send", input);
      if (result?.state === "submitted") $("wallet-send-panel").close();
    };
    $("wallet-reveal-form").onsubmit = async event => {
      event.preventDefault(); const password = $("wallet-reveal-password").value; $("wallet-reveal-password").value = "";
      const result = await controller.perform("wallet.reveal", { password });
      if (result && typeof result.wif === "string" && result.wif.length < 200) { text("wallet-backup", `Save this backup key privately:\n${result.wif}`); $("wallet-backup").hidden = false; $("hide-backup").hidden = false; }
    };
    const leave = controller.leave;
    controller.leave = () => { leave(); $("wallet-send-panel").close(); $("wallet-reveal-panel").open = false; $("restore-wallet").open = false; };
    root.KaiCoreWallet = controller;
    document.addEventListener("visibilitychange", () => { if (document.hidden) controller.leave(); else if (!page.hidden) controller.enter(); });
    root.addEventListener("kai-core-privacy-changed", event => controller.observe(controller.snapshot().wallet, event.detail?.mode));
  }
  if (typeof module === "object" && module.exports) module.exports = { amount, atomAmount, validateSummary, validateHistory, createController };
  if (root) mount();
})(typeof window === "object" ? window : null);
