# Plugin repositories

The nine repositories below other than Node, Remote Access and Registry now contain
installable v0.1.0 plugin releases requiring Core 0.2.0. Those three repositories
remain pending. Official installs work directly from GitHub releases without the registry.

| Repository | Responsibility | Legacy starting point |
| --- | --- | --- |
| `kai-plugin-registry` | Public catalog and reviewed publisher/release metadata | New catalog; points to first- and third-party release URLs |
| `kai-plugin-assistant` | Chat, history, KAI companion, voice and optional desktop assistance | UI chat, mascot and companion files; private actions need explicit broker APIs |
| `kai-plugin-brain` | Personal memories, sources, goals and recall | CompanionBrain, CompanionSources and private store |
| `kai-plugin-connections` | Connected accounts and app integrations | CompanionConnections, Composio, account-specific tools |
| `kai-plugin-workflows` | Visual builder, reusable agents, saved workflows and automation | CompanionWorkflows, workflow engine/events/schedules |
| `kai-plugin-agent-network` | Discovery, hiring, hosting, jobs and service earnings | core/lib/agent-network and its UI |
| `kai-plugin-documents` | Document workspace and file-generation capabilities | DocStore and document UI; exporters need bounded broker APIs |
| `kai-plugin-model-compare` | Side-by-side model comparison | Existing comparison UI |
| `kai-plugin-code` | Koinos Code projects and coding tools | CodeAgent, CodeProjects and CLI; native operations need a separately reviewed execution host |
| `kai-plugin-tools` | MCP/tool-server management and tool discovery | McpManager, NodeRuntime and tool UI; broker must own external processes |
| `kai-plugin-koinos-node` | Node lifecycle, producer controls and node-specific wallet operations | KoinosNode and node UI |
| `kai-plugin-remote-access` | Opt-in authenticated access to the local API from elsewhere | RemoteAccess and its controls |

Core keeps model installation/runtime routing, secure wallet and payment services,
compute-provider earning, permission enforcement, profile management and the plugin
host. Plugins never own raw wallet keys. No separate repository is needed for a
wallet plugin, model downloader, updater or SDK at this stage.

Core API 2 supplies reviewed legacy-data adapters for the nine releases. Feature
renderers remain sandboxed; signed packages cannot load native source as privileged
code. Each plugin README documents the supported subset and remaining legacy
functionality. Continue extending the API with native tests for each new capability.

Workflows and Agent Network are separate plugins. Workflows alone supports
personal creation; Agent Network alone supports hiring external services; both
allow creating and hosting services. Keep a single versioned workflow runtime
package in kai-core initially; do not duplicate the engine in both repositories.
Public-web research is a future constrained tool capability, not unrestricted HTTP.
Paid rental integration is unfinished and remains disabled until separately validated.
