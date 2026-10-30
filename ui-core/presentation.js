"use strict";
(function (root) {
  const paths = {
    assistant: '<path d="M5 4h14v12H9l-4 4Z"/><path d="M8 8h8M8 12h5"/>',
    brain: '<path d="M9 4C3 2 2 10 5 12c-4 5 2 10 7 7V5c0-4 8-2 7 3 5 2 3 8 0 8 0 5-7 6-7 3M5 12h3M16 8h3M15 15h4"/>',
    connections: '<path d="m9 15 6-6M9 7l2-2a4 4 0 0 1 6 6l-2 2M15 17l-2 2a4 4 0 0 1-6-6l2-2"/>',
    workflows: '<path d="M3 3h6v6H3ZM15 15h6v6h-6M6 9v9h9M14 5h7M17.5 1.5v7"/>',
    network: '<circle cx="12" cy="5" r="3"/><circle cx="5" cy="18" r="3"/><circle cx="19" cy="18" r="3"/><path d="m10 8-4 7m8-7 4 7M8 18h8"/>',
    documents: '<path d="M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6"/>',
    compare: '<path d="M4 4h6v16H4ZM14 4h6v16h-6"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    tools: '<path d="M14 4a6 6 0 0 0-7 8l-4 4a3 3 0 0 0 4 4l5-4a6 6 0 0 0 8-7l-4 4-5-5Z"/>',
    node: '<path d="m12 3-9 5v9l9 5 9-5V8ZM3 8l9 5 9-5M12 13v9M7.5 5.5l9 5"/>',
    remote: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8M12 16v5m-3-11 2 2 4-4"/>',
    plugin: '<path d="M4 4h6v3a2 2 0 1 0 4 0V4h6v6h-3a2 2 0 1 0 0 4h3v6h-6v-3a2 2 0 1 0-4 0v3H4v-6h3a2 2 0 1 0 0-4H4Z"/>',
  };
  const official = {
    "kai.assistant": ["Assistant", "Chat with your local models and keep your conversation history.", "assistant"],
    "kai.brain": ["Brain", "Organize your memories, notes, sources, and goals.", "brain"],
    "kai.connections": ["Connections", "Connect apps and accounts for actions you approve.", "connections"],
    "kai.workflows": ["Workflows", "Build reusable agents and run your saved workflows.", "workflows"],
    "kai.agent-network": ["Agent Network", "Create, discover, and run agent services.", "network"],
    "kai.documents": ["Documents", "Write, organize, and draft documents with local AI.", "documents"],
    "kai.model-compare": ["Compare Models", "Compare answers from your installed local models.", "compare"],
    "kai.code": ["Koinos Code", "Review AI code suggestions and edit selected project files.", "code"],
    "kai.tools": ["Tools", "Connect tool servers and run the tools you approve.", "tools"],
    "kai.koinos-node": ["Koinos Node", "Set up, inspect, and manage your existing Koinos node.", "node"],
    "kai.remote-access": ["Remote Access", "Give trusted clients secure access to your local models.", "remote"],
  };
  function get(id, entry = {}) {
    const item = Object.hasOwn(official, id) ? official[id] : null;
    const name = item?.[0] || (typeof entry.name === "string" && entry.name.trim() ? entry.name : "Community plugin");
    const description = item?.[1] || (typeof entry.description === "string" && entry.description.trim() ? entry.description : "Add a capability from an independent developer.");
    const symbol = item?.[2] || "plugin";
    return { name, description, icon: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[symbol]}</svg>` };
  }
  const api = Object.freeze({ get });
  if (typeof module === "object") module.exports = api;
  if (root) root.KaiPluginPresentation = api;
})(typeof window === "object" ? window : null);
