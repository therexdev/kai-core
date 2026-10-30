"use strict";
// Original device-link/account panel extracted from ui/app.js at kaiapp
// 34d17faa0526213b8fc0ac7a65aa7f2c186c6547. Existing Core account endpoints
// retain the session, keyring and signing behavior; the renderer sees no tokens.
(() => {
const $ = id => document.getElementById(id);
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const KaiI18n = window.KaiI18n || { html: (strings, ...values) => typeof strings === "string" ? strings : strings.reduce((out,part,index) => out+part+(values[index]??""),""), setText: (node,text) => { if(node)node.textContent=text; } };
const accountNotice = window.KaiCoreNotice.create({container:$("account-notice"),message:$("account-msg"),close:$("account-msg-close"),focusTarget:()=>$("btn-account-signin")});
/* ---- Koinos AI account (task #49): device-link sign-in + wallet attach.
 * The app never shows a login form: Sign in fetches a short code, the user
 * approves it at <site>/link in any browser, and the app polls until its own
 * session arrives. All calls go through Core, which refuses them in
 * Local-Only privacy mode with words. */
let accountFetchedAt = 0;
let accountPolling = false;
let websiteAccount = true;
let accountEpoch = 0;
const accountPath = suffix => (websiteAccount ? "/core/website-account" : "/core/account") + suffix;
function selectAccountScope(website) {
  websiteAccount = !!website;
  accountEpoch++;
  accountPolling = false;
  accountFetchedAt = 0;
  accountGrantId = null;
  for (const id of ["account-code-row", "account-web", "account-signedin", "account-signedout"]) $(id).hidden = true;
  for (const id of ["btn-account-signin", "btn-account-linkwallet", "btn-account-signout"]) $(id).disabled = false;
  accountMsg("");
  return renderAccount(true);
}
window.selectAccountScope = selectAccountScope;
$("btn-account-scope").addEventListener("click", () => selectAccountScope(!websiteAccount));
// The grant this window may revoke: this machine's wallet, resolved server-
// side in account.status(). Held here so the revoke button never has to guess
// which of several grants it means.
let accountGrantId = null;

function accountMsg(text, ok) {
  const el = $("account-msg");
  el.hidden = !text;
  el.textContent = text || "";
  el.classList.toggle("account-success", !!ok);
  accountNotice.show(text || "", { error: !!text && !ok });
}

async function renderAccount(force) {
  if (!force && Date.now() - accountFetchedAt < 30000) return; // egress — don't ride the 2s earn timer
  accountFetchedAt = Date.now();
  const epoch = accountEpoch;
  const so = $("account-signedout");
  const si = $("account-signedin");
  let j = {};
  try {
    const r = await fetch(accountPath(""));
    j = await r.json();
    if (epoch !== accountEpoch) return;
    if (!r.ok || !j.ok) throw new Error(j.localOnly ? "Privacy is set to Local-Only — accounts need network access (Settings → AI privacy)." : j.error || `HTTP ${r.status}`);
  } catch (e) {
    if (epoch !== accountEpoch) return;
    so.hidden = true;
    si.hidden = true;
    return accountMsg(e.message);
  }
  $("account-heading").textContent = j.scope === "credits" ? "AI credit account" : "Koinos AI account";
  $("account-hint").textContent = j.scope === "credits"
    ? "Connect your existing credit account using its browser sign-in. Wallet connection in Credits and device setup in Earn also work without this sign-in. Your website and Connections sign-in stays saved separately."
    : "Sign in to your website account for Connections and web access. Approve the app's short code in your browser, then link this wallet if needed.";
  $("btn-account-scope").hidden = !j.separateCreditAccount;
  $("btn-account-scope").textContent = websiteAccount ? "Open AI credit account" : "Website account and Connections";
  $("account-web").hidden = true;
  /*
   * Three different things used to look identical here: signed out, session
   * rejected, and the account server simply unreachable. The last one is the
   * common case during a deploy, and telling someone to sign in again when
   * the site is merely restarting sends them off to redo a device link they
   * never needed to redo.
   */
  if (j.offline) {
    so.hidden = true;
    si.hidden = true;
    return accountMsg(`${j.error || "Can't reach the account server."} Your sign-in is still saved — this should clear by itself.`);
  }
  accountMsg(j.sessionRejected ? "That session has ended. Sign in again to reconnect this device." : "");
  if (j.verifyUrl || j.site) {
    const link = $("account-verify-link");
    const url = (j.site || "https://koinosai.com") + "/link";
    link.href = url;
    link.textContent = url.replace(/^https:\/\//, "");
  }
  if (j.signedIn) {
    so.hidden = true;
    si.hidden = false;
    const a = j.account;
    const methods = [
      a.email ? "email" : null,
      a.google ? "Google" : null,
      a.passkeys?.length ? `${a.passkeys.length} passkey${a.passkeys.length > 1 ? "s" : ""}` : null,
    ].filter(Boolean);
    const rows = [
      ["Signed in as", a.email || a.id],
      ["Sign-in methods", methods.join(", ") || "none yet — add a passkey on the account page"],
      ["Linked wallets", String(a.wallets?.length ?? 0)],
      ["This wallet", j.thisWalletLinked ? "✓ linked to your account" : "not linked yet"],
    ];
    $("account-stats").innerHTML = rows.map(([k, v]) => KaiI18n.html`<span class="k">${k}</span><span>${esc(v)}</span>`).join("");
    $("btn-account-linkwallet").hidden = Boolean(j.thisWalletLinked);
    if (j.scope !== "credits") renderWebAccess(j);
  } else {
    si.hidden = true;
    so.hidden = false;
    $("account-web").hidden = true;
    if (j.pendingCode) {
      $("account-code-row").hidden = false;
      $("account-code").textContent = j.pendingCode;
      startAccountPoll();
    }
  }
}

function startAccountPoll() {
  if (accountPolling) return;
  accountPolling = true;
  const epoch = accountEpoch, pollPath = accountPath("/link/poll");
  const tick = async () => {
    if (epoch !== accountEpoch) return;
    try {
      const r = await fetch(pollPath, { method: "POST" });
      const j = await r.json();
      if (epoch !== accountEpoch) return;
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (j.pending) {
        setTimeout(tick, 3000);
        return;
      }
      accountPolling = false;
      $("account-code-row").hidden = true;
      accountMsg("Signed in.", true);
      if (!websiteAccount) window.dispatchEvent(new Event("kai-credit-identity-changed"));
      renderAccount(true);
    } catch (e) {
      if (epoch !== accountEpoch) return;
      accountPolling = false;
      $("account-code-row").hidden = true;
      accountMsg(e.message);
      $("btn-account-signin").disabled = false;
    }
  };
  setTimeout(tick, 3000);
}

$("btn-account-signin").addEventListener("click", async () => {
  const epoch = accountEpoch;
  const btn = $("btn-account-signin");
  btn.disabled = true;
  accountMsg("");
  try {
    const r = await fetch(accountPath("/link/start"), { method: "POST" });
    const j = await r.json();
    if (epoch !== accountEpoch) return;
    if (!r.ok || !j.ok) throw new Error(j.localOnly ? "Privacy is set to Local-Only — switch it in Settings → AI privacy first." : j.error || `HTTP ${r.status}`);
    $("account-code-row").hidden = false;
    $("account-code").textContent = j.userCode;
    KaiI18n.setText($("account-poll-status"), "Waiting for approval… approve the code in your browser.");
    startAccountPoll();
  } catch (e) {
    if (epoch !== accountEpoch) return;
    accountMsg(e.message);
    btn.disabled = false;
  }
});

$("btn-account-linkwallet").addEventListener("click", async () => {
  const epoch = accountEpoch;
  const btn = $("btn-account-linkwallet");
  btn.disabled = true;
  accountMsg("");
  try {
    const r = await fetch(accountPath("/wallet"), { method: "POST" });
    const j = await r.json();
    if (epoch !== accountEpoch) return;
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    accountMsg("Wallet linked — it now shows on your account everywhere.", true);
    if (!websiteAccount) window.dispatchEvent(new Event("kai-credit-identity-changed"));
    renderAccount(true);
  } catch (e) {
    if (epoch !== accountEpoch) return;
    accountMsg(e.message);
  } finally {
    if (epoch === accountEpoch) btn.disabled = false;
  }
});

$("btn-account-signout").addEventListener("click", async () => {
  const epoch = accountEpoch;
  try {
    const r = await fetch(accountPath("/logout"), { method: "POST" });
    const j = await r.json();
    if (!r.ok || !j.ok) throw Error(j.error || "Sign-out failed");
  } catch (e) { if (epoch === accountEpoch) accountMsg(e.message); return; }
  if (epoch !== accountEpoch) return;
  $("btn-account-signin").disabled = false;
  if (!websiteAccount) window.dispatchEvent(new Event("kai-account-signed-out"));
  accountMsg("Signed out on this device.", true);
  renderAccount(true);
});

/* ---- web access: a signed spending cap for koinosai.com ----
 *
 * The website cannot create this. It has no key — nothing in a browser does —
 * so the authorisation has to be signed here, on the machine that holds the
 * wallet. What the site gets is a cap and an expiry, and it can never draw
 * past either. That is the entire trust model, and it is worth the extra
 * click it costs.
 *
 * Only offered once this wallet is LINKED: granting spend from a wallet the
 * account has never proven it owns would be authorising a stranger.
 */
function renderWebAccess(j) {
  const box = $("account-web");
  box.hidden = !j.thisWalletLinked;
  if (!j.thisWalletLinked) return;
  const g = j.thisWalletGrant;
  accountGrantId = g ? g.id : null;
  $("account-grant-none").hidden = Boolean(g);
  $("account-grant-live").hidden = !g;
  if (j.site) $("account-web-open").href = j.site.replace(/\/$/, "") + "/app";
  if (!g) return;
  const days = Math.max(0, Math.round((g.expiresAt - Date.now()) / 86400000));
  const rows = [
    ["Authorised", `$${g.maxUsd.toFixed(2)} of model usage`],
    ["Used so far", `$${g.spentUsd.toFixed(4)}`],
    ["Left", `$${g.remainingUsd.toFixed(4)}`],
    ["Expires", days > 1 ? `in ${days} days` : days === 1 ? "tomorrow" : "today"],
  ];
  $("account-grant-stats").innerHTML = rows
    .map(([k, v]) => KaiI18n.html`<span class="k">${k}</span><span>${esc(v)}</span>`).join("");
}

$("btn-account-grant").addEventListener("click", async () => {
  const epoch = accountEpoch;
  const btn = $("btn-account-grant");
  const maxUsd = Number($("account-grant-cap").value);
  const days = Number($("account-grant-days").value);
  if (!isFinite(maxUsd) || maxUsd <= 0) return accountMsg("Set a spending cap above zero.");
  // Say the number back before signing it. This is the only moment the cap
  // is chosen, and it is the only thing standing between the website and the
  // wallet — a typo here is not something to discover later.
  if (!confirm(`Authorise koinosai.com to spend up to $${maxUsd.toFixed(2)} of model usage from this wallet over the next ${days} days?\n\nYou can end this at any time, from here or from the website.`)) return;
  btn.disabled = true;
  accountMsg("");
  try {
    const r = await fetch(accountPath("/grant"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxUsd, days }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (epoch !== accountEpoch) return;
    accountMsg(`Web access authorised — up to $${maxUsd.toFixed(2)} for ${days} days.`, true);
    renderAccount(true);
  } catch (e) {
    if (epoch === accountEpoch) accountMsg(e.message);
  } finally {
    if (epoch === accountEpoch) btn.disabled = false;
  }
});

$("btn-account-grant-revoke").addEventListener("click", async () => {
  const epoch = accountEpoch;
  const btn = $("btn-account-grant-revoke");
  if (!accountGrantId) return accountMsg("Nothing to end — reload Settings.");
  if (!confirm("End web access now? The website stops being able to spend immediately. Anything already spent stays spent.")) return;
  btn.disabled = true;
  try {
    const r = await fetch(accountPath("/grant/revoke"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: accountGrantId }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    if (epoch !== accountEpoch) return;
    accountMsg("Web access ended.", true);
    renderAccount(true);
  } catch (e) {
    if (epoch === accountEpoch) accountMsg(e.message);
  } finally {
    if (epoch === accountEpoch) btn.disabled = false;
  }
});


window.renderAccount = renderAccount;
window.KaiCoreAccount = {
  enter() { return renderAccount(false); },
  openWebsite() { return selectAccountScope(true); },
  openCredit() { return selectAccountScope(false); },
};
// Only an explicitly opened Settings view triggers status reads. Pending
// device-code approval continues when the user returns to a plugin.
let refreshTimer = setInterval(() => { if (!document.hidden && !document.querySelector('[data-panel="settings"]').hidden) void renderAccount(false); }, 30000);
window.addEventListener("pagehide", () => { accountEpoch++; accountPolling=false; clearInterval(refreshTimer); });
window.addEventListener("focus", () => { if (!document.querySelector('[data-panel="settings"]').hidden) void renderAccount(false); });
$("account-settings").addEventListener("click", event => {
  const link=event.target.closest?.("a[href]"); if (!link || !/^https:\/\//i.test(link.getAttribute("href")||"")) return;
  event.preventDefault(); void window.kaiCore.call("desktop.openExternal",{url:link.href}).catch(error=>accountMsg(error.message));
});
})();
