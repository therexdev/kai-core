"use strict";
(function (root) {
  const SCALE = 100000000n, MAX = (1n << 64n) - 1n;
  function atoms(value) {
    if (typeof value !== "string" || !/^(0|[1-9]\d{0,11})(\.\d{1,8})?$/.test(value)) throw Error("Invalid wallet amount");
    const [whole, fraction = ""] = value.split("."), result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
    if (result > MAX) throw Error("Invalid wallet amount"); return result;
  }
  function koinAmount(value, locale) {
    const n = atoms(value), digits = n > 0n && n < SCALE ? 8 : 4, scale = 10n ** BigInt(digits);
    const rounded = (n + SCALE / scale / 2n) / (SCALE / scale);
    const fraction = String(rounded % scale).padStart(digits, "0").replace(/0+$/, "");
    const separator = new Intl.NumberFormat(locale).formatToParts(1.1).find(p => p.type === "decimal").value;
    return (rounded / scale).toLocaleString(locale) + (fraction ? separator + fraction : "");
  }
  function usdAmount(koin, price, locale) {
    const cents = (atoms(koin) * atoms(price) + 50000000000000n) / 100000000000000n;
    return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .formatToParts(cents / 100n).map(p => p.type === "fraction" ? String(cents % 100n).padStart(2, "0") : p.value).join("");
  }
  function presentation(state, now, locale = "en") {
    const balance = state.balance, fresh = balance && !state.error && balance.observedAt <= now + 5000 && now - balance.observedAt < 60000;
    const price = state.privacy !== "local-only" && state.price && state.price.expiresAt > now ? state.price : null;
    const symbol = balance?.tokenSymbol || "KOIN";
    return { koin: balance ? koinAmount(balance.koin, locale) : "—", symbol,
      usd: fresh && balance.network === "mainnet" && price ? usdAmount(balance.koin, price.usdPerKoin, locale) : "—",
      exact: balance ? `${balance.koin} ${symbol}` : null, stale: !!balance && !fresh,
      hint: !state.address ? "Set up wallet" : !balance || !fresh ? "Wallet balance unavailable" : balance.network !== "mainnet" ? "Testnet balance has no USD value" : !price ? "KOIN price unavailable" : "Estimated wallet value in USD" };
  }
  function createController({ call, price, render = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const state = { address: null, privacy: "local-only", balance: null, price: null, error: false };
    let visible = true, closed = false, generation = 0, pending = null, timer = null, expiry = null;
    function paint() {
      clearTimer(expiry); render(state);
      const boundaries = [state.balance?.observedAt + 60000, state.price?.expiresAt].filter(t => Number.isSafeInteger(t) && t > now());
      if (!closed && visible && boundaries.length) expiry = setTimer(paint, Math.min(...boundaries) - now());
    }
    function stop() { generation++; pending = null; clearTimer(timer); clearTimer(expiry); }
    function observe(wallet, privacy = "local-only") {
      const address = wallet?.address || null;
      const changed = address !== state.address, privacyChanged = privacy !== state.privacy;
      if (changed || privacyChanged) {
        stop(); state.address = address; state.privacy = privacy; state.price = null;
        if (changed) { state.balance = null; state.error = false; }
        paint(); if (visible) void refresh();
      }
    }
    async function refresh() {
      if (closed || !visible || !state.address) return;
      if (pending) return pending;
      clearTimer(timer);
      const address = state.address, g = generation, current = () => !closed && visible && generation === g && state.address === address;
      const task = (async () => {
        let deadline;
        try {
          const balance = await Promise.race([call("wallet.summary", {}), new Promise((_, reject) => { deadline = setTimer(() => reject(Error("Wallet balance unavailable")), 20000); })]);
          if (!current()) return;
          if (balance?.address !== address || !["mainnet", "harbinger"].includes(balance.network) || balance.tokenSymbol !== (balance.network === "mainnet" ? "KOIN" : "tKOIN") ||
              !Number.isSafeInteger(balance.observedAt) || balance.observedAt > now() + 5000 || now() - balance.observedAt >= 60000) throw Error("Wallet balance unavailable");
          atoms(balance.koin); state.balance = { address, network: balance.network, tokenSymbol: balance.tokenSymbol, koin: balance.koin, observedAt: balance.observedAt }; state.error = false; paint();
        } catch { if (current()) { state.error = true; state.price = null; paint(); } return; }
        finally { clearTimer(deadline); }
        if (!current() || state.privacy === "local-only" || state.balance.network !== "mainnet") { if (current()) { state.price = null; paint(); } return; }
        try {
          const result = await Promise.race([price(), new Promise((_, reject) => { deadline = setTimer(() => reject(Error("KOIN price unavailable")), 16000); })]);
          if (!current()) return;
          const estimate = result?.estimate, value = estimate?.priceDetails?.usdPerKoin;
          if (!atoms(value) || !Number.isSafeInteger(estimate.observedAt) || estimate.observedAt > now() + 5000 || now() - estimate.observedAt >= 1800000 ||
              !Number.isSafeInteger(estimate.expiresAt) || estimate.expiresAt <= now() || estimate.expiresAt > now() + 60000) throw Error("KOIN price unavailable");
          state.price = { usdPerKoin: value, expiresAt: estimate.expiresAt }; paint();
        } catch { if (current()) { state.price = null; paint(); } }
        finally { clearTimer(deadline); }
      })();
      pending = task;
      try { await task; } finally { if (pending === task) pending = null; if (current()) timer = setTimer(refresh, 30000); }
    }
    return { observe, refresh, repaint: paint,
      setVisible(value) { if (visible === value) return; visible = value; stop(); if (visible) { paint(); void refresh(); } },
      close() { closed = true; stop(); }, snapshot: () => structuredClone(state) };
  }
  function mount() {
    const button = root?.document?.getElementById("sidebar-wallet"), bridge = root?.kaiCore;
    if (!button || !bridge) return;
    const $ = id => root.document.getElementById(id), locale = root.KaiI18n;
    const controller = createController({ call: (...args) => bridge.call(...args), price: () => bridge.credit("purchase-estimate", { usd: "1" }),
      render(state) {
        const view = presentation(state, Date.now(), locale?.language || "en");
        $("sidebar-wallet-amount").textContent = view.koin; $("sidebar-wallet-token").textContent = view.symbol;
        $("sidebar-wallet-usd").textContent = `${view.usd} USD`; button.dataset.stale = String(view.stale);
        button.title = [view.exact, `${view.usd} USD`, locale?.t(view.hint) || view.hint].filter(Boolean).join("\n");
        button.setAttribute("aria-label", `${locale?.t("Open wallet") || "Open wallet"}: ${view.koin} ${view.symbol}, ${view.usd} USD`);
      } });
    button.onclick = () => root.dispatchEvent(new CustomEvent("kai-core-navigate", { detail: { page: "wallet" } }));
    root.document.addEventListener("visibilitychange", () => controller.setVisible(!root.document.hidden));
    root.addEventListener("kai-credit-identity-changed", () => controller.observe(null));
    root.document.addEventListener("kai:language-changed", controller.repaint);
    bridge.onClosing?.(() => controller.close()); controller.setVisible(!root.document.hidden); controller.repaint();
    root.KaiSidebarWallet = controller;
  }
  if (typeof module === "object" && module.exports) module.exports = { atoms, koinAmount, usdAmount, presentation, createController };
  if (root) mount();
})(typeof window === "object" ? window : null);
