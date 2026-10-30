# Core and installed-app integration check

`apps-smoke.js` opens the real Core entry point and each app's real sandboxed interface and native service in a fresh disposable profile. It also launches the Assistant desktop companion, checks navigation/tray continuity, saves a changed app order, removes all apps, and quits Core.

## Released package mode

Download the eleven exact assets listed in `apps-publishers.json` into one directory. Set `KAI_SMOKE_PACKAGES_DIR` to that directory and run:

```sh
node scripts/foundation/apps-smoke.js --synthetic-keychain
```

The package mode verifies each file with Core's streaming signature verifier and requires the pinned ID, version and publisher fingerprint before installation. The test fixture explicitly approves native trust for these verified packages. It records each downloaded asset's SHA-256 and byte length. It does not replace the user-facing installation review check.

Set `KAI_SMOKE_RUNTIME_ROOT` to a built `resources/app.asar` to load every running Core module from the actual package. Test preparation still uses the current source verifier. Set `KAI_FOUNDATION_APPS_OUTPUT` for the JSON report and individual app screenshots. The default location is the operating system's temporary directory under `kai-foundation-apps-smoke`.

`KAI_FOUNDATION_SMOKE_IDS` optionally selects a comma-separated subset for diagnosis. CI should omit it to require all eleven apps. `KAI_SMOKE_SYNTHETIC_LOCK=1` skips the application singleton check only within the test fixture; singleton behavior needs its own check.

## Source fixture mode

Without `KAI_SMOKE_PACKAGES_DIR`, the harness signs sibling plugin sources with an ephemeral test key. `KAI_PLUGIN_SOURCES` overrides their parent directory. Assistant uses its prepared `.build/plugin` tree. This mode constructs source payloads in memory; use streaming package mode for the universal Assistant bundle.

## Coverage limits

Public network requests are blocked, and native confirmation dialogs cancel. The check does not start Docker or perform real model inference, blockchain transactions, OAuth, downloads, or microphone/camera actions. Apps may perform their normal read-only dependency detection, such as checking whether Docker is installed. No saved user profile is used. `--synthetic-keychain` supplies an ephemeral encrypted test store instead of the OS keychain. Headless Linux supplies a synthetic tray object while exercising Core's real close/show/quit handlers. These conditions are recorded in the report.
