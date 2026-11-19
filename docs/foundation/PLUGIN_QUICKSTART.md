# Create your first KAI Core plugin

This guide targets KAI Core Beta 0.7.14 and the Foundation plugin format. You need basic HTML/JavaScript, Git, Node.js and npm. You do not need a wallet, paid credits or an AI model to build the notes example below.

A plugin supplies its own interface and feature logic. Core handles installation, shared models and the public service APIs. Third-party developers use the same SDK as KAI's own plugins.

## 1. Choose a starting point

| Start with | Use it for | Access |
| --- | --- | --- |
| [Sandboxed notes](../../examples/sandboxed-notes) | Notes, small tools, local AI interfaces | Packaged browser UI, plugin storage and local inference; no Node.js or direct network access |
| [Native counter](../../examples/native-counter) | Background services, integrations, filesystem or process features | Sandboxed UI plus trusted code in Electron's main process |

Start sandboxed unless your feature requires native code. Native installation grants full access available to the KAI application; manifest permissions do not sandbox native code. Signatures identify the publisher and protect package integrity, not code safety.

## 2. Copy the notes example

Run these commands in a terminal (PowerShell, bash or zsh):

```sh
git clone https://github.com/therexdev/kai-core.git
cd kai-core
npm ci --ignore-scripts
node -e "require('node:fs').cpSync('examples/sandboxed-notes','../my-kai-notes',{recursive:true,errorOnExist:true,force:false})"
```

Keep running the later commands from the `kai-core` directory. Your plugin lives next door in `my-kai-notes`, outside Core's source tree. No Electron installation or Core installer build is needed just to package this example.

The example contains four files:

| File | Purpose |
| --- | --- |
| `manifest.json` | Plugin identity, version, entry point and permissions |
| `index.html` | Interface markup |
| `app.js` | Load and save the note using Core's API |
| `style.css` | Interface styling |

Edit `../my-kai-notes/manifest.json`. Replace `yourname` with your own lowercase publisher namespace:

```json
{
  "schema": 2,
  "apiVersion": 3,
  "id": "yourname.notes",
  "version": "1.0.0",
  "name": "My Notes",
  "description": "A simple private notepad inside KAI Core.",
  "entry": "index.html",
  "runtime": "sandboxed",
  "permissions": ["storage.read", "storage.write"],
  "provides": [],
  "consumes": []
}
```

Also change the heading and title in `index.html`. Keep the ID stable after publication. Versions must use three numeric components, such as `1.0.1`; prerelease suffixes are not accepted. Do not add fields such as `author`, `minCoreVersion` or `dependencies` to this manifest: unknown fields are rejected.

## 3. Understand the API

The installed interface calls `window.kai`. For example, inside an async function:

```js
await window.kai.call("storage.set", { key: "note", value: "Hello KAI" });
const note = await window.kai.call("storage.get", { key: "note" });
```

Storage is scoped to your plugin. The copied `app.js` already handles loading, saving and errors. Opening `index.html` in an ordinary browser will not provide `window.kai`; install the signed package in Core to test the integration.

| Renderer call | Permission | Input |
| --- | --- | --- |
| `storage.get` | `storage.read` | `{ key }` |
| `storage.set` | `storage.write` | `{ key, value }` |
| `models.list` | `models.read` | `{}` |
| `inference.local` | `inference.local` | `{ model, prompt, maxTokens }` |

To add local AI later, add `models.read` and `inference.local` to permissions, list models, and let the user choose an installed, ready alias. `inference.local` returns `{ text }`. Prompts are limited to 16,000 characters and `maxTokens` to 1–4,096. This call does not fall back to paid network inference.

Keep JavaScript in packaged script files: inline scripts and CDN scripts are blocked. Package assets locally, and use `textContent` when displaying user or AI text. Sandboxed renderers cannot fetch arbitrary URLs.

## 4. Generate your publisher key once

From `kai-core`, create an Ed25519 private key outside both repositories:

```sh
node -e "const fs=require('node:fs'); const crypto=require('node:crypto'); const key=crypto.generateKeyPairSync('ed25519').privateKey; fs.writeFileSync('../kai-plugin-publisher-private.pem',key.export({type:'pkcs8',format:'pem'}),{flag:'wx',mode:0o600});"
```

Keep this file private and back it up securely. On Windows, use a private user folder and appropriate file permissions; the POSIX mode does not configure Windows ACLs. Never commit, upload or put the private key inside your plugin directory. The command refuses to overwrite an existing key. Use your existing key for later releases.

## 5. Package and install

```sh
node scripts/core/pack-plugin.js ../my-kai-notes ../kai-plugin-publisher-private.pem ../my-kai-notes-1.0.0.kaiplugin
```

The packer validates the manifest, files and signature before writing. It prints your publisher fingerprint and refuses to overwrite an existing output file. A `.kaiplugin` file is a signed package, not a renamed ZIP.

In the installed KAI Core app:

1. Open **Plugins → Install 3rd Party Plugins**.
2. Select `my-kai-notes-1.0.0.kaiplugin`.
3. Review its publisher fingerprint and permissions, then approve installation.
4. Open your plugin from **Apps**, save a note, and restart Core to check that it persists.

For each iteration, change the version (for example, to `1.0.1`), pack to a matching new filename using the same key, and install the new package. Editing your source folder does not update the installed copy.

## 6. When you need a native service

Use [native-counter](../../examples/native-counter) as the next example. Its manifest declares `runtime: "native"`, a `service` entry and `native.execute`, plus the permissions it actually uses. The service exports `create(api)` and returns a `call(method, input, signal)` handler; custom renderer calls reach that plugin's handler.

The native SDK is **version 1** (`api.version`), while manifests use **schema 2 / API 3**. These are separate version numbers.

Native services can use shared models, protected storage, network requests and declared plugin-to-plugin services. Store mutable files in `api.plugin.dataDir`, not the versioned code directory. Validate inputs, honor cancellation, and implement `dispose()` to stop timers, requests and processes. Enabled services can remain active while the user changes Apps or closes Core to its tray.

Network inference requires `inference.network` and `wallet.authorize`, and uses Core's reviewed credit flow. Opening a plugin is not payment approval. The wallet API is not a generic transaction signer or private-key export. Never forward remote/rented agent input into the local service bus or expose a native SDK object to remote job code.

See the [author guide](PLUGIN_AUTHOR_GUIDE.md) for lifecycle, native permissions, service contracts and credit details, and [TypeScript API reference](api-v1.d.ts) for exact signatures.

## 7. Share a release

Put your source in your own GitHub repository and attach the signed `.kaiplugin` to a versioned GitHub Release. Tell users to download the file and use the local installation flow above. Publishing a GitHub release does not itself add the plugin to Core's catalog.

Include a README describing what the plugin does, its permissions, tested Core version and operating systems, installation steps, and your publisher fingerprint. Keep releases immutable and retain the same publisher key: Core binds an installed plugin ID to its first approved publisher. Removing a plugin does not clear that binding or silently erase its retained data.

Bundle dependencies and their licenses before packaging. Core does not run npm or installation scripts on users' computers. Native dependencies need builds compatible with the target OS, architecture and Electron ABI; a Windows binary will not work on a Raspberry Pi.

Before sharing, test install, save/restart, update and disable/remove behavior. For native plugins, also test cancellation and cleanup on every supported platform. Check missing models, unavailable accounts and Local-Only mode if your feature uses them. Do not include credentials, test wallet data or your signing key in a package.

## Common problems

| Symptom | Check |
| --- | --- |
| `window.kai` is missing | Run the packaged plugin inside Core, not a standalone browser. |
| Permission denied | Declare the exact permission, repack and install the new version. |
| Script or external resource blocked | Use packaged files and external script tags, not inline code or CDN URLs. |
| Package validation fails | Use schema 2 / API 3; check unknown fields, permissions, paths and version format. |
| Output already exists | Use a fresh versioned output filename. |
| Publisher mismatch during update | Sign with the original publisher key. |
| Source edits do not appear | Repack and install; Core runs its verified installed copy. |
| Local inference fails | Check the selected model is installed and ready and inputs fit the limits. |

Further reading: [full author guide](PLUGIN_AUTHOR_GUIDE.md), [API types](api-v1.d.ts), [architecture](ARCHITECTURE.md).
