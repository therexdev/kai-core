# Plugin APIs 1 and 2

Plugins are signed UTF-8 JSON `.kaiplugin` packages. No npm install hooks, Node
modules, executable binaries or host shell commands run during installation.
They can be hosted in any developer's repository; public HTTPS URLs are fetched
with DNS-pinned public-address checks on every redirect and a 5 MiB limit.

The manifest includes `schema: 1`, `apiVersion: 1` (public) or `2` (Core 0.2.0+), a stable dotted/dashed ID,
`name`, optional `description`, `version` (three numeric components), an HTML
`entry` and a unique permission list. See `plugins/examples/local-chat`.

The package contains exactly `manifest`, `files`, `publicKey` and `signature`.
`files` maps relative paths to text. The signature is Ed25519 over canonical JSON
of `{manifest, files}` (sorted object keys). Public key is base64 DER SPKI;
signature is base64. The installer displays the SHA-256 publisher fingerprint.
A valid signature proves key continuity, not that a publisher was reviewed.

Generate a private publisher key outside the repository (keep it private):

```sh
openssl genpkey -algorithm ED25519 -out /private/path/publisher.pem
npm run plugin:pack -- plugins/examples/local-chat /private/path/publisher.pem /tmp/local-chat.kaiplugin
```

Choose **Plugins → Install package** to test it. The private key is never packaged.
Publish `.kaiplugin` files as release assets; their URL is what users install.
Core 0.3.0 supports the signed [public registry](https://github.com/therexdev/kai-plugin-registry).
Its versioned entries pin exact package digests, keys, grants and minimum Core versions.
Core 0.4.5 refreshes catalog metadata automatically at startup, every 15 minutes,
and on app/Plugins returns (throttled to one minute). Manual refresh is also
available. Refresh is public-HTTPS-only and blocked in Local-Only mode;
expiration, signatures and monotonic release sequences are checked before caching.
A badge counts installed plugins with newer versions from the same publisher.
Installation still requires native permission review, including for updates.
Dependency installation, publisher key rotation and automatic installation are not supported.
Reinstalling a newer signed package reviews its permissions again and retains one
previous version for rollback. Removal retains private plugin data and its publisher
binding; another key cannot claim that data by reusing the same ID.

## Renderer API

All requests use `window.kai.call(method, input)` and return promises.

| Method | Permission | Input/result |
| --- | --- | --- |
| `models.list` | `models.read` | Returns alias, label and status only |
| `inference.local` | `inference.local` | `{model,prompt,maxTokens?}` → `{text}` |
| `storage.get` | `storage.read` | `{key}` → saved value or null |
| `storage.set` | `storage.write` | `{key,value}` → true |

Local inference requires an installed model, at most 16,000 prompt characters,
1–4,096 output tokens and a three-minute deadline. It uses the private local route,
with no network-model fallback. Closing/disabling a plugin cancels its requests.
Storage is limited to 32 keys/1 MiB per plugin. Wallet keys, arbitrary filesystem and unrestricted network operations are not public capabilities.

## First-party feature scopes (API 2)

`core/lib/plugins/contracts.json` defines exact methods and grants for the official
Assistant, Brain, Connections, Workflows, Agent Network, Documents, Code, Tools,
Koinos Node and Remote Access plugins. The last two require Core 0.3.0. Model Compare uses only public capabilities. Official IDs and their private
feature methods require the publisher fingerprint pinned in `first-party.json`, both
at installation and dispatch. A valid third-party signature cannot claim those IDs
or private scopes. Each service is lazy and closes with its plugin.

The reviewed adapter owns legacy stores, credentials, native dialogs and child
processes. It returns only the relevant feature data; it never exports wallet keys or
account tokens. File writes, external-account actions, process launches and service
publication have native review and cancellation checks. Agent Network cannot call
Brain, Connections, Code or Tools. Workflow services accept only their supported
local/manual graph subset; saved incompatible graphs remain intact.

Official releases are signed outside GitHub, with the publisher private key kept
privately. Each plugin repository commits its signed release and public key. CI
verifies the signature and exact source match before publishing the immutable
`.kaiplugin` asset; private signing material is never in the repository or workflow.

The host revalidates signatures at launch, binds each IPC request to the exact
plugin window's main frame and entry document, and enforces grants independently
of plugin JavaScript. Renderer Node integration is off, context isolation and
sandboxing are on. Each plugin uses an ephemeral session, restrictive CSP and
its own resource protocol; navigation, subframes, popups, downloads, device
permissions and direct network/file requests are denied. No shared browser cookies.
This is an initial capability API, not an invitation to bypass it for native code.
