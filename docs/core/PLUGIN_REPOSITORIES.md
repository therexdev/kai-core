# Plugin repositories

The 0.2.0 restoration targets Core 0.5.0. Each feature renderer is independently packaged; its reviewed native engine adapter ships with Core. These versions describe the source compatibility target, not a claim that release artifacts have already passed publication gates.

| Repository | Official ID | Restored responsibility |
| --- | --- | --- |
| [kai-plugin-assistant](https://github.com/therexdev/kai-plugin-assistant) | `kai.assistant` | Full chat/history, advanced modes, provider settings, voice and desktop companion |
| [kai-plugin-brain](https://github.com/therexdev/kai-plugin-brain) | `kai.brain` | Memory graph, memories, goals/tasks, sources, sync, awareness and orchestration |
| [kai-plugin-connections](https://github.com/therexdev/kai-plugin-connections) | `kai.connections` | Original app catalog, OAuth, profiles, connected tools, custom APIs and approval receipts |
| [kai-plugin-workflows](https://github.com/therexdev/kai-plugin-workflows) | `kai.workflows` | Original visual builder, agents, templates, full graph engine, runs, schedules and task migration |
| [kai-plugin-agent-network](https://github.com/therexdev/kai-plugin-agent-network) | `kai.agent-network` | Discover, create/host services, invitations, jobs, delivery review, earnings and network settings |
| [kai-plugin-documents](https://github.com/therexdev/kai-plugin-documents) | `kai.documents` | Original writing canvas, autosave, selected-text revisions, streamed suggestions and import/export |
| [kai-plugin-model-compare](https://github.com/therexdev/kai-plugin-model-compare) | `kai.model-compare` | Blind comparison, presets, sequential streaming, reveal, votes and original scoreboard |
| [kai-plugin-code](https://github.com/therexdev/kai-plugin-code) | `kai.code` | Original Code projects/sessions, planning, reviewed edits/commands, tools and GitHub workflows |
| [kai-plugin-tools](https://github.com/therexdev/kai-plugin-tools) | `kai.tools` | Tools & accounts, MCP catalogs/servers/trust, Node runtime, email/calendar and Developer tools |
| [kai-plugin-koinos-node](https://github.com/therexdev/kai-plugin-koinos-node) | `kai.koinos-node` | All seven Node sections, shared wallet, funding, producer custody, reward returns and node maintenance |
| [kai-plugin-remote-access](https://github.com/therexdev/kai-plugin-remote-access) | `kai.remote-access` | Original Local API/Remote Access screen, gateway keys, budgets/usage and authenticated relay |
| [kai-plugin-registry](https://github.com/therexdev/kai-plugin-registry) | Not an installed plugin | Separately signed catalog, publisher/release metadata and developer submissions |

The original source reference for all extractions is `therexdev/kaiapp` Test commit `34d17faa0526213b8fc0ac7a65aa7f2c186c6547`. Original UI assets/provenance and renderer adaptations are tracked in each repository. See [PLUGIN_PARITY.md](PLUGIN_PARITY.md) for the feature and validation matrix.

Core keeps the common shell, models/runtime, secure wallet and payments, compute-provider earning, account linking, profile management, original shared services and the permission-enforcing plugin host. A separate wallet, model downloader or updater repository is not needed. The registry is data consumed by Core; it is not privileged executable code.

Workflows and Agent Network remain separate. Workflows builds personal agents and automations. Agent Network can discover/use compatible external services without installing the builder. Installing both allows a compatible private graph to be copied into an isolated hosted service. The graph/runtime implementation remains in Core; copied service versions cannot inherit private Brain, connection credentials or desktop capabilities. Paid rental contracts were unavailable in the reference deployment and are not invented by this extraction.

Third-party developers can host signed `.kaiplugin` releases in their own repositories and submit catalog entries for review, or distribute public HTTPS URLs/files directly. They use the [public capability API](PLUGIN_API.md); private scopes and official IDs require the pinned KAI publisher. Release signing keys never belong in a repository.

A renderer update and a native engine change have separate release responsibilities. Package and verify each changed plugin, update exact catalog digests/permissions/minimum Core requirements, run the integrated native checks, then publish through the appropriate manual release process. Do not describe source-only changes as already installed updates.
