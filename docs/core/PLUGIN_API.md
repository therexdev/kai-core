# Plugin APIs and packaging

Core 0.5.0 hosts public API 1 plugins and publisher-bound API 2 feature plugins. The restored first-party renderers are version 0.2.0 and require the matching Core feature implementations. `apiVersion: 2`, plugin version `0.2.0` and Core version `0.5.0` are separate version numbers. Catalog entries carry minimum Core compatibility; it is not an extra manifest field.

## Signed packages

A `.kaiplugin` is a UTF-8 JSON envelope containing exactly `manifest`, `files`, `publicKey` and `signature`. Installation runs no npm hooks or native code. Packages may be hosted in any developer's repository or another public HTTPS location. Downloads apply public-address/DNS checks on redirects and the same size limit as local packages.

- Maximum serialized package size: **24 MiB**, including base64 and JSON overhead.
- Between **1 and 250 files**, with safe relative paths and no case-insensitive duplicates.
- Text assets: `.html`, `.js`, `.css`, `.svg`, `.json`, `.txt`.
- Binary assets: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.wav`, `.ogg`, `.mp3`, `.woff`, `.woff2`, encoded as canonical base64 values in `files`.
- The HTML entry must exist in the package. Binary media assets do not grant microphone, camera, network or native execution access.

The manifest has `schema: 1`, `apiVersion: 1` or `2`, a stable dotted/dashed `id`, `name`, optional `description`, three-component numeric `version`, HTML `entry` and unique `permissions`. Unknown fields and permissions are rejected. See `plugins/examples/local-chat` and `core/lib/plugins/package.js` for the authoritative format.

Ed25519 signs canonical JSON of `{manifest, files}` with sorted object keys. The public key is base64 DER SPKI; the signature is base64. Core displays the SHA-256 publisher fingerprint. A signature proves publisher-key continuity, not that the code has been reviewed.

```sh
openssl genpkey -algorithm ED25519 -out /private/path/publisher.pem
npm run plugin:pack -- plugins/examples/local-chat /private/path/publisher.pem /tmp/local-chat.kaiplugin
```

Keep publisher private keys outside repositories and CI logs. Install a package from **Plugins → Install 3rd Party Plugins**, or publish it as an immutable release asset. The separate signed [registry](https://github.com/therexdev/kai-plugin-registry) pins each listed digest, publisher, permission set and minimum Core version. Automatic catalog refresh only detects updates; installing them still requires native review. Dependencies, automatic installation and publisher-key rotation are not supported. Rollback retains one prior package. Removal retains private data and its publisher binding.

## Public renderer API

All requests use `window.kai.call(method, input)` and return promises.

| Method | Permission | Input/result |
| --- | --- | --- |
| `models.list` | `models.read` | Alias, label and installation status only |
| `inference.local` | `inference.local` | `{model,prompt,maxTokens?}` → `{text}` |
| `storage.get` | `storage.read` | `{key}` → saved value or null |
| `storage.set` | `storage.write` | `{key,value}` → true |

Public local inference requires an installed model, at most 16,000 prompt characters, 1–4,096 output tokens and a three-minute deadline. It cannot fall back to a network model. Public storage permits 32 keys and 1 MiB per plugin. These limits describe the public API; restored native feature engines retain their own original limits rather than being squeezed through public text inference or plugin JSON storage.

## Official feature APIs

`core/lib/plugins/contracts.json` is the authoritative method-to-permission table for all eleven features, including Model Compare. `first-party.json` pins official IDs and publishers. Installation and dispatch both reject private scopes from a different ID or signer. Merely declaring API 2 does not grant them.

Each native adapter exposes a feature-specific allowlist. Some original renderers use an HTTP-shaped compatibility bridge, but it translates reviewed routes into `window.kai.call`; it does not give the renderer a generic HTTP proxy. The native process owns the original engines, guarded stores, keychain credentials, dialogs and child processes. A feature receives the data needed for its original workspace, including explicitly selected workflow context, without blanket access to other private features.

Common official methods include:

| Method | Permission | Boundary |
| --- | --- | --- |
| `desktop.openView` | `desktop.navigate` | Fixed Core/plugin views and supported sections; opens another installed feature |
| `desktop.openExternal` | `desktop.external` | Reviewed HTTPS URL without embedded credentials |
| `desktop.preferencesRead` | `desktop.preferences` | Fixed non-secret original interface preference keys for that plugin |

Original action approvals remain in place. Additional native review binds sensitive operations to their actual arguments, files, account, wallet/network or stored transaction summary. Node wallet operations share Core's financial coordination and recheck their operation lifetime before signing and submission. Private-key backup uses a native display/copy dialog rather than returning a private key to plugin JavaScript. Original one-time API-key creation and external-wallet connection QR flows remain explicit feature operations; they do not expose stored wallet keys or Core account tokens.

## Windows, background work and isolation

Every plugin window has Node integration disabled, sandboxing and context isolation enabled, an ephemeral session, its own resource protocol, and exact sender/main-frame/entry checks. The host verifies the installed package again at launch. Direct HTTP/file requests, subframes, arbitrary navigation, popups and downloads are blocked. Pinned official packages may use the inline styles required by original renderers; inline scripts remain blocked. The Assistant's reviewed microphone/camera flow is a narrow session-bound exception to device denial, with no general device grant for plugins.

Closing a window aborts requests belonging to that window. It does not disable a background-capable feature. Core verifies enabled first-party packages and their complete required permissions before starting their original configured background behavior. Schedules, awareness, approved auto-connect, remote sessions, agent hosting and Node supervision use service lifetimes; they cannot retain a closed window's authorization for a new sensitive action. Disable/remove, privacy changes and app shutdown have separate cancellation/drain behavior. Node retains its original Docker continuity on app quit and explicitly stops managed containers on disable/remove. Node networking and explicit blockchain wallet actions remain independent of AI Local-Only; they never enable online AI as a side effect. See the [lifecycle matrix](PLUGIN_PARITY.md#background-and-privacy).

Official package CI verifies signatures and correspondence to committed source before publishing an immutable artifact. Updating a native adapter also requires a Core update; a new renderer package cannot inject native implementation code.
