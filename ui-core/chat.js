"use strict";
(function (root) {
  const MAX_INPUT_BYTES = 24000, MAX_PROMPT_BYTES = 16000, MAX_REPLY_BYTES = 1000000;
  const bytes = value => new TextEncoder().encode(value).length;
  const cleanError = error => String(error?.message || error || "Chat could not finish").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").slice(0, 1000);
  const modelId = value => String(value || "").replace(/^koinos-network:/, "");
  function conversation(turns, prompt) {
    const messages = [{ role: "user", content: prompt }];
    for (let index = turns.length - 1; index >= 0; index--) {
      const turn = turns[index];
      if (turn.state !== "done") continue;
      const previous = [{ role: "user", content: turn.prompt }, { role: "assistant", content: turn.answer }];
      if (messages.length + 2 > 31 || bytes(JSON.stringify([...previous, ...messages])) > MAX_INPUT_BYTES) break;
      messages.unshift(...previous);
    }
    if (bytes(JSON.stringify(messages)) > MAX_INPUT_BYTES) throw Error("Send a shorter message");
    return messages;
  }
  function completionText(result) {
    const text = result?.choices?.[0]?.message?.content;
    if (typeof result?.id !== "string" || !/^[a-f0-9]{64}$/i.test(result.id) || typeof text !== "string" || !text.trim() || bytes(text) > MAX_REPLY_BYTES) throw Error("The network reply could not be read. Resume the saved request to recover it.");
    return text;
  }
  function recoveredTurns(messages, answer) {
    if (!Array.isArray(messages) || messages.length > 64 || bytes(JSON.stringify(messages)) > MAX_INPUT_BYTES) throw Error("The saved conversation could not be read");
    const turns = [];
    for (const message of messages) {
      if (!message || typeof message.content !== "string") throw Error("The saved conversation could not be read");
      // A saved advanced chat may contain a system instruction. It is never
      // imported into this simple chat's future model requests.
      if (message.role === "system") continue;
      if (message.role === "user") turns.push({ prompt: message.content, answer: "", state: "failed" });
      else if (message.role === "assistant" && turns.length) Object.assign(turns.at(-1), { answer: message.content, state: "done" });
      else throw Error("The saved conversation could not be read");
    }
    if (!turns.length || turns.at(-1).state === "done") throw Error("The saved conversation could not be read");
    Object.assign(turns.at(-1), { answer, state: "done" });
    return turns;
  }

  function createChatController({ bridge, onChange = () => {}, now = Date.now, refreshCredits = () => {} }) {
    const state = { source: "local", models: [], selected: { local: "", network: "" }, turns: { local: [], network: [] }, draft: { local: "", network: "" }, info: null, privacyMode: "local-only", busy: false, status: "", error: false, checking: false };
    let active = null, infoPromise = null, generation = 0, disposed = false;
    const emit = () => { if (!disposed) onChange(state); };
    const allowedNetwork = () => state.privacyMode !== "local-only";
    const fresh = () => state.info && !state.info.blocked && (state.info.modelAvailabilityUntil === undefined || Number.isSafeInteger(state.info.modelAvailabilityUntil) && state.info.modelAvailabilityUntil > now());
    function models() { return state.source === "local" ? state.models.map(m => ({ id: m.alias, label: m.label || m.alias, available: true })) : (state.info?.models || []).map(m => ({ ...m, id: modelId(m.model), label: m.label || m.model, available: m.available === true && !!fresh() })); }
    function update(snapshot) {
      state.models = (snapshot?.models || []).filter(m => m.status === "ready");
      const mode = snapshot?.network?.privacyMode || "local-only";
      if (mode !== state.privacyMode) invalidate({ privacyMode: mode });
      if (!state.models.some(m => m.alias === state.selected.local)) state.selected.local = state.models.find(m => m.alias === snapshot?.runtime?.activeAlias)?.alias || state.models[0]?.alias || "";
      if (!allowedNetwork() && active?.source === "network") void stop();
      emit();
    }
    async function refreshNetwork() {
      if (!allowedNetwork()) { emit(); return null; }
      if (!infoPromise) {
        const token = { generation };
        state.checking = true; emit();
        infoPromise = token;
        token.promise = (async () => {
          try {
            const info = await bridge.credit("chat-info");
            if (generation !== token.generation) return null;
            if (!info || typeof info.enabled !== "boolean" || info.models !== undefined && !Array.isArray(info.models)) throw Error("Network chat is unavailable. Check Network or try Refresh models.");
            state.info = info;
            if (!state.selected.network) state.selected.network = modelId(info.models?.find(m => m.available)?.model || info.models?.[0]?.model);
            return info;
          } catch (error) { if (generation !== token.generation) return null; state.info = { ...state.info, blocked: cleanError(error), enabled: false }; return state.info; }
          finally { if (infoPromise === token) { state.checking = false; infoPromise = null; emit(); } }
        })();
        return token.promise;
      }
      return infoPromise.promise;
    }
    async function setSource(source) {
      if (active || !["local", "network"].includes(source)) return false;
      state.source = source; state.status = ""; state.error = false; emit();
      if (source === "network") await refreshNetwork();
      return true;
    }
    function setModel(model) { if (!active) { state.selected[state.source] = state.source === "network" ? modelId(model) : model; emit(); } }
    function setDraft(text) { state.draft[state.source] = String(text); }
    function networkReady() {
      if (!allowedNetwork()) throw Error("Local-Only is on. Change Privacy in Settings to use network models.");
      if (!state.info?.configured || state.info.enabled !== true) throw Error(state.info?.blocked || "Network chat is unavailable. Check Network to connect.");
      if (state.info.blocked) throw Error(String(state.info.blocked));
      if (!fresh()) throw Error("Model availability expired. Refresh models before sending.");
    }
    function priority() {
      return { freeOnly: state.info.freeOnlySession === true, paidFirst: false };
    }
    function checkStopped(operation) { if (operation.stopped || disposed) throw Error("Chat stopped. Resume any saved network request to recover its reply."); }
    function progress(value) {
      const operation = active;
      if (!operation || operation.source !== "network" || operation.stopped || !operation.started) return;
      if (typeof value?.text === "string") { state.status = value.text.slice(0, 500); emit(); }
      if (typeof value?.delta !== "string" || !/^[a-f0-9]{64}$/i.test(value.requestId || "")) return;
      if (operation.requestId && operation.requestId !== value.requestId) return;
      operation.requestId = value.requestId;
      if (bytes(operation.partial + value.delta) > MAX_REPLY_BYTES) return;
      operation.partial += value.delta;
      if (operation.turn) operation.turn.answer = operation.partial;
      emit();
    }
    async function acknowledge(result, operation) {
      try {
        const ack = await bridge.credit("chat-ack", result.id);
        if (ack?.state !== "delivered") throw Error("The network did not confirm delivery");
        return true;
      } catch (error) { if (!operation.discard) { state.status = `Reply received. Delivery confirmation failed: ${cleanError(error)}. The saved request is still available.`; state.error = true; } return false; }
    }
    async function send(prompt = state.draft[state.source]) {
      if (active || disposed) return false;
      prompt = String(prompt).trim();
      if (!prompt || bytes(prompt) > MAX_PROMPT_BYTES) { state.status = prompt ? "Send a shorter message (up to 16,000 bytes)." : "Write a message first."; state.error = true; emit(); return false; }
      const source = state.source, turns = state.turns[source];
      // Retrying an interrupted turn keeps one copy of the user's message.
      if (turns.at(-1)?.state === "failed" && turns.at(-1).prompt === prompt) turns.pop();
      let messages;
      try { messages = conversation(turns, prompt); }
      catch (error) { state.status = cleanError(error); state.error = true; emit(); return false; }
      const turn = { prompt, answer: "", state: "pending" };
      const operation = { source, turn, stopped: false, started: false, partial: "" }; active = operation;
      turns.push(turn); state.draft[source] = ""; state.busy = true; state.error = false; state.status = source === "local" ? "Preparing your local model…" : "Checking network availability…"; emit();
      let success = false;
      try {
        let text;
        if (source === "local") {
          const model = state.selected.local;
          if (!state.models.some(m => m.alias === model)) throw Error("Choose an installed model in Models to start chatting.");
          operation.started = true;
          const result = await bridge.call("chat.local", { model, messages, maxTokens: 1024 });
          checkStopped(operation);
          text = result?.text;
          if (typeof text !== "string" || !text.trim() || bytes(text) > MAX_REPLY_BYTES) throw Error("Local model returned an invalid reply");
          Object.assign(turn, { answer: text, state: "done" }); state.status = ""; emit();
        } else {
          await refreshNetwork(); checkStopped(operation); networkReady();
          const model = state.selected.network;
          if (!state.info.models?.some(m => modelId(m.model) === model && m.available === true)) throw Error("This network model is unavailable. Choose an available model.");
          const input = { model: `koinos-network:${model}`, messages, stream: true, ...priority() };
          operation.started = true; state.status = "Waiting for the network model…"; emit();
          const result = await bridge.credit("chat-completion", input);
          checkStopped(operation); text = completionText(result);
          if (operation.requestId && operation.requestId !== result.id || !text.startsWith(operation.partial)) throw Error("The network reply changed during delivery. Resume the saved request to recover it.");
          Object.assign(turn, { answer: text, state: "done" }); state.status = ""; emit();
          await acknowledge(result, operation);
        }
        success = true;
      } catch (error) {
        if (!operation.discard) {
          turn.state = "failed"; turn.error = operation.stopped ? "Reply stopped" : cleanError(error);
          state.status = operation.stopped ? "Chat stopped. Any unfinished network request can be resumed when available." : cleanError(error);
          state.error = !operation.stopped; state.draft[source] = prompt;
        }
      } finally {
        active = null; state.busy = false; emit();
        if (source === "network") { void refreshCredits(); void refreshNetwork(); }
      }
      return success;
    }
    async function stop() {
      const operation = active;
      if (!operation || operation.stopped) return;
      operation.stopped = true; state.status = "Stopping…"; emit();
      if (!operation.started) return;
      try { if (operation.source === "local") await bridge.call("chat.stop"); else await bridge.credit("stop"); }
      catch (error) { if (!operation.discard) { state.status = `Stop requested: ${cleanError(error)}`; emit(); } }
    }
    async function recover() {
      if (active || disposed || state.source !== "network") return false;
      const operation = { source: "network", stopped: false, started: false, partial: "" }; active = operation;
      state.busy = true; state.error = false; state.status = "Resuming the saved request…"; emit();
      try {
        await refreshNetwork(); checkStopped(operation);
        // A saved, verified answer can be recovered while model availability is
        // offline. The native flow enforces any authorization needed to retry.
        if (!allowedNetwork()) throw Error("Local-Only is on. Change Privacy in Settings to resume a network request.");
        if (!state.info?.configured || !state.info.enabled || !state.info.recoveryAvailable) throw Error("No saved network request is available for this account.");
        operation.started = true;
        const result = await bridge.credit("chat-recover"); checkStopped(operation);
        if (result?.state === "none") { state.status = "No saved request is available."; return false; }
        const answer = completionText(result?.completion);
        if (operation.requestId && operation.requestId !== result.completion.id || !answer.startsWith(operation.partial)) throw Error("The recovered reply changed during delivery");
        state.turns.network = recoveredTurns(result.messages, answer); state.draft.network = ""; state.status = "Saved reply recovered."; emit();
        await acknowledge(result.completion, operation);
        return true;
      } catch (error) { if (!operation.discard) { state.status = cleanError(error); state.error = true; } return false; }
      finally { active = null; state.busy = false; emit(); void refreshCredits(); void refreshNetwork(); }
    }
    function clear() { if (!active) { state.turns[state.source] = []; state.draft[state.source] = ""; state.status = ""; state.error = false; emit(); } }
    function invalidate({ privacyMode, identity = false } = {}) {
      generation++; infoPromise = null; state.info = null; state.checking = false;
      if (privacyMode) state.privacyMode = privacyMode;
      if (active?.source === "network") { if (identity) active.discard = true; void stop(); }
      if (identity) { state.turns.network = []; state.draft.network = ""; state.status = "Network account changed."; state.error = false; }
      emit();
    }
    return { state, models, update, setSource, setModel, setDraft, send, stop, recover, clear, refreshNetwork, progress, fresh, invalidate,
      dispose() { void stop(); disposed = true; } };
  }

  function mount(window, document) {
    const host = document.getElementById("chat-content"); if (!host || !window.kaiCore) return null;
    host.innerHTML = `<div class="chat-shell">
      <div class="chat-toolbar"><div class="chat-route-controls"><label for="chat-source">Chat with<select id="chat-source"><option value="local">Local model</option><option value="network">Network model</option></select></label><label for="chat-model">Model<select id="chat-model" aria-label="Chat model"></select></label></div><div class="actions"><button id="chat-refresh" type="button" hidden>Refresh models</button><button id="chat-new" type="button">New chat</button></div></div>
      <p id="chat-model-detail" class="chat-model-detail muted"></p>
      <div id="chat-messages" class="chat-messages" role="log" aria-label="Chat messages" aria-live="polite"></div>
      <div id="chat-empty" class="chat-empty"><img class="brand-mark" src="assets/brand-mark.svg" width="64" height="64" alt=""><h2 class="chat-welcome">How can I help?</h2><p>Ask a question or start a conversation.</p><button id="chat-setup" type="button">Choose a model</button></div>
      <div id="chat-recovery" class="chat-recovery" hidden><p>An unfinished network request is available. Resuming uses credits if the reply needs to be retried.</p><button id="chat-recover" type="button">Resume saved request</button></div>
      <div id="chat-status-notice" class="dismissible-notice inline-notice" hidden><p id="chat-status" class="chat-status" role="status"></p><button id="chat-status-close" class="notice-close" type="button" aria-label="Dismiss message" title="Dismiss message"><span aria-hidden="true">×</span></button></div>
      <form id="chat-form" class="chat-composer"><label class="sr-only" for="chat-input">Message</label><textarea id="chat-input" rows="3" maxlength="16000" placeholder="Message KAI…"></textarea><div class="chat-compose-actions"><span id="chat-hint" class="muted"></span><button id="chat-stop" type="button" hidden>Stop</button><button id="chat-send" type="submit" class="primary">Send</button></div></form>
    </div>`;
    const $ = id => document.getElementById(id);
    const statusNotice = window.KaiCoreNotice.create({ container: $("chat-status-notice"), message: $("chat-status"), close: $("chat-status-close"), focusTarget: () => $("chat-input") });
    let source = "local", signature = "", messagesSignature = "", visible = false;
    const controller = createChatController({ bridge: window.kaiCore, onChange: render, refreshCredits: () => window.KaiCredits?.refresh() });
    function render(state) {
      const network = state.source === "network", models = controller.models(), picked = models.find(m => m.id === state.selected[state.source]);
      const optionsSignature = JSON.stringify([state.source, models, state.selected[state.source]]);
      if (signature !== optionsSignature) {
        signature = optionsSignature; $("chat-model").replaceChildren();
        if (!models.length) { const option = document.createElement("option"); option.value = ""; option.textContent = network ? "No network models available" : "No local models installed"; $("chat-model").append(option); }
        for (const model of models) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.label + (model.available ? "" : " · unavailable"); option.disabled = !model.available; $("chat-model").append(option); }
        $("chat-model").value = state.selected[state.source];
      }
      if (source !== state.source || document.activeElement !== $("chat-input")) $("chat-input").value = state.draft[state.source];
      source = state.source; $("chat-source").value = source;
      $("chat-source").disabled = state.busy; $("chat-model").disabled = state.busy || state.checking;
      $("chat-new").disabled = state.busy; $("chat-input").disabled = state.busy; $("chat-stop").hidden = !state.busy; $("chat-send").hidden = state.busy;
      $("chat-refresh").hidden = !network; $("chat-refresh").disabled = state.busy || state.checking || state.privacyMode === "local-only";
      $("chat-send").disabled = state.busy || !picked?.available || network && (!state.info?.enabled || !!state.info?.blocked || state.privacyMode === "local-only");
      $("chat-recovery").hidden = !network || !state.info?.recoveryAvailable; $("chat-recover").disabled = state.busy || state.privacyMode === "local-only";
      statusNotice.show(state.status, { error: state.error, dismissible: !state.busy });
      $("chat-hint").textContent = network ? "Your network conversation is sent to the selected network model." : "Messages stay on this computer.";
      $("chat-model-detail").textContent = !network ? (picked ? "Runs locally on your computer." : "Install or import a model in Models to start chatting.")
        : state.privacyMode === "local-only" ? "Local-Only is on. Open Settings to allow network chat."
        : state.checking ? "Checking network models…"
        : state.info?.blocked || (state.info?.enabled !== true ? "Network chat is unavailable. Check Network to connect."
        : `${state.info.freeOnlySession ? "Uses free credits only." : "Uses eligible free credits first, then purchased credits."}${state.info.maxRequestCredits ? ` Up to ${state.info.maxRequestCredits} credits per message.` : ""}${picked?.inputCreditsPerMillion !== undefined ? ` ${picked.inputCreditsPerMillion} input / ${picked.outputCreditsPerMillion} output credits per million tokens.` : ""}`);
      const turns = state.turns[source], serialized = JSON.stringify(turns);
      if (messagesSignature !== serialized) {
        messagesSignature = serialized; const log = $("chat-messages"), nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 100;
        log.replaceChildren();
        for (const turn of turns) {
          for (const [role, content] of [["user", turn.prompt], ["assistant", turn.answer || (turn.state === "pending" ? "Thinking…" : turn.error || "Reply stopped")]]) {
            const bubble = document.createElement("article"); bubble.className = `chat-message ${role}${turn.state === "failed" && role === "assistant" ? " error" : ""}`;
            const label = document.createElement("strong"), body = document.createElement("div"); label.textContent = role === "user" ? "You" : "KAI"; body.textContent = content; bubble.append(label, body);
            if (role === "assistant" && turn.answer && turn.state === "failed") { const note = document.createElement("small"); note.textContent = turn.error || "Reply interrupted"; bubble.append(note); }
            log.append(bubble);
          }
        }
        if (nearBottom || state.busy) log.scrollTop = log.scrollHeight;
      }
      $("chat-messages").hidden = !turns.length; $("chat-empty").hidden = !!turns.length;
      $("chat-setup").hidden = !!picked?.available && (!network || state.privacyMode !== "local-only");
      $("chat-setup").textContent = network ? state.privacyMode === "local-only" ? "Open Settings" : "Open Network" : "Open Models";
    }
    $("chat-source").onchange = event => { void controller.setSource(event.target.value); };
    $("chat-model").onchange = event => controller.setModel(event.target.value);
    $("chat-input").oninput = event => controller.setDraft(event.target.value);
    $("chat-form").onsubmit = event => { event.preventDefault(); statusNotice.clear(); void controller.send($("chat-input").value); };
    $("chat-input").onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$("chat-send").disabled && !controller.state.busy) { statusNotice.clear(); void controller.send(event.target.value); } } };
    $("chat-new").onclick = () => controller.clear(); $("chat-stop").onclick = () => { void controller.stop(); };
    $("chat-recover").onclick = () => { statusNotice.clear(); void controller.recover(); }; $("chat-refresh").onclick = () => { void controller.refreshNetwork(); };
    $("chat-setup").onclick = () => window.dispatchEvent(new window.CustomEvent("kai-core-navigate", { detail: { page: controller.state.source === "local" ? "models" : controller.state.privacyMode === "local-only" ? "settings" : "network" } }));
    const unsubscribe = window.kaiCore.onChatProgress?.(controller.progress);
    window.addEventListener("kai-core-use-network-model", async event => {
      if (controller.state.busy) return;
      await controller.setSource("network"); controller.setModel(event.detail?.model);
      window.dispatchEvent(new window.CustomEvent("kai-core-navigate", { detail: { page: "chat" } }));
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) void controller.stop(); });
    window.addEventListener("kai-core-privacy-changed", event => {
      const mode = event.detail?.mode;
      if (["local-only", "local-first", "network"].includes(mode)) { controller.invalidate({ privacyMode: mode }); if (visible && controller.state.source === "network") void controller.refreshNetwork(); }
    });
    for (const event of ["kai-credit-identity-changed", "kai-account-signed-out"]) window.addEventListener(event, () => {
      controller.invalidate({ identity: true }); if (visible && controller.state.source === "network") void controller.refreshNetwork();
    });
    window.addEventListener("beforeunload", () => { unsubscribe?.(); controller.dispose(); });
    const timer = window.setInterval(() => { if (visible && !document.hidden && controller.state.source === "network" && !controller.state.busy) void controller.refreshNetwork(); }, 15000);
    window.addEventListener("beforeunload", () => window.clearInterval(timer));
    render(controller.state);
    return { update: controller.update, show() { visible = true; if (controller.state.source === "network") void controller.refreshNetwork(); }, hide() { visible = false; void controller.stop(); } };
  }
  if (typeof module === "object" && module.exports) module.exports = { createChatController, conversation, recoveredTurns, mount };
  if (root?.document) root.KaiCoreChat = mount(root, root.document);
})(typeof window === "object" ? window : null);
