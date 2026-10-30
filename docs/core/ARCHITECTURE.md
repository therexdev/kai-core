# Core architecture and release gates

`electron/core-main.js` owns native UI, the shared-profile singleton, migration
preflight, verified plugin installation, native payment review and shutdown.
`electron/core-tray.js` keeps the main window hidden on Close when a tray icon is
available. This preserves the provider and shared-profile lock. Explicit Quit,
OS session end, and updater restart use the awaited native teardown; repeated
quit events cannot bypass pending cleanup. If the tray cannot be created, Close
quits normally. Tray assets are also unpacked for Linux desktop hosts.
`core/server.js` with `extensions:false` supplies models, local inference/API,
wallet/account services, network policy and the existing compute provider backend.
Legacy automatic task/node/Brain behavior is disabled. Official feature adapters
start lazily through `electron/plugin-services`; contracts and publisher pins gate
every call, independently of the renderer.
`ui-core` is the trusted first-party control surface. Plugin windows use a different
preload, separate sessions and a capability broker; they never inherit its IPC.

The public registry is a separately signed metadata release. Core pins its signing
key, validity period and monotonic sequence, then verifies each downloaded plugin
against the catalog's package digest, publisher, grants and minimum Core version.
Registry entries cannot add private feature permissions to community publishers.
Refresh is explicit. The bundled eleven official entries are used only before a
catalog is cached; an invalid or expired cache does not resurrect withdrawn entries.

Node and Remote Access remain off until a reviewed Start action. The Node adapter
uses the existing node manager without legacy reward/signing automation, retains
databases and keys in place, and stops containers it started when closed. The
Remote Access adapter accepts only authenticated installed-model listing and
bounded local text inference. It never proxies arbitrary Core gateway routes.
Remote keys are scoped separately from gateway keys; old keys require explicit
adoption. Native teardown is awaited during disable, update and shutdown, and
Local-Only stops both services and pending catalog/package downloads.

The legacy source is retained for extraction and compatibility tests. Optional
speech/mail dependencies are devDependencies rather than installed
production dependencies. The old UI is not served by the new desktop. Only the
shared credit presentation and reward-summary scripts are mapped as explicit static assets.

Built-in simple chat uses a trusted native local adapter with bounded text input,
private desktop routing and cancellation. It cannot silently fall back to paid
network inference. Network chat uses the existing native credit service and its
verified delivery/recovery protocol. Local and network transcripts are separate
and last only for the app session; resuming a saved network request is explicit.
The UI has separate Wallet, Your Credits, and Buy credits screens, with balances
and history sourced from the verified credit state and native payment journal.

The data/profile contract is distinct from the installer/update contract. Core
must be able to reuse encrypted identity and installed files without targeting an
Alpha/Test installation or publishing to its release feed. Runtime singleton name
and userData are shared; install app ID and updater repository are different.

## Release gates

1. Core tests and retained compatibility suite pass; report backend-dependent skips.
2. Native plugin probe runs with Chromium OS sandbox enabled on a regular CI user.
3. Windows standalone executable check proves all Alpha/Test/Core exclusion pairs
   and OS-protected credential reuse. Linux/macOS native credential behavior needs
   platform verification as well; mocks do not prove keychain migration.
4. Preview installers launch using their packaged dependencies. No automatic
   publication or updater feed until platform signing and upgrade checks pass.
5. Complete remaining legacy feature extraction and reviewed migration before claiming
   feature parity or recommending that users stop supporting Alpha/Test.

The Linux container may require `--no-sandbox --ozone-platform=headless` to run a
synthetic renderer test and a fixture-only singleton substitution when Unix
sockets are unavailable. Those are test limitations, never production switches.
Desktop smoke uses a temporary profile and synthetic wallet, not real user data.

Source baseline: therexdev/kaiapp Test 34d17faa0526213b8fc0ac7a65aa7f2c186c6547.
Repository publication is not installer publication. No chain transfers, contract
changes, scheduler deployments or user wallet migrations are performed by tests.

GitHub connector import records the exact source baseline above. Full earlier Git
ancestry remains in therexdev/kaiapp; this repository starts with a source snapshot.

## Plugin presentation

First-party plugins package the common light workspace theme and dismissible notice helper from `scripts/core/plugin-ui`. Run `node scripts/core/sync-plugin-ui.js` before signing a presentation update; the copies are part of each signed package and have no privileged APIs. Each feature keeps its original app layout in a separate sandboxed window. The plugin host uses the matching light background while loading. Existing broker permissions and data formats are unchanged.
