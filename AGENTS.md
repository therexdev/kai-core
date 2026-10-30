# KAI Core development

- This is therexdev/kai-core, the plugin-based successor. Work only here; never push, promote or release changes to therexdev/kaiapp from this project.
- `main` is the development branch. Installer publication is manual and must follow native verification. Inherited documentation describes the old app and is historical unless linked by README.md.
- Preserve the existing `Koinos AI` Electron runtime name, userData/sessionData paths, singleton lock, core data path and model locations. Installer ID/product/updater are KAI Core only. Alpha, Test and Core must exclude one another before opening shared data.
- Back up configuration and encrypted credentials BEFORE any runtime reads that might migrate state. Never overwrite corrupt wallet/profile data, regenerate an existing wallet, relocate models or node databases, or auto-restore chain/payment journals.
- Core starts with legacy optional extensions disabled. Saved Brain/workflow/account/node data remains in place. Plugins receive only reviewed manifest capabilities and never wallet keys or account tokens. Private feature APIs are pinned to each official plugin ID and publisher; each can access only its own feature data. Native filesystem and process actions require explicit, bounded broker approval.
- Keep plugin renderer sandboxing and exact sender/main-frame/entry checks. No Node-enabled third-party extensions. Deny unknown permissions. Verify package signatures on installation AND launch.
- Run `npm test`, `npm run test:compat`, and relevant native checks. Never imply a local synthetic test proves Windows/macOS keychain migration or an installer release.
