# Windows signing and Core updates

Core uses the existing Azure Trusted Signing / Artifact Signing account and certificate profile used by Koinos AI. The verified Windows publisher is **Michael Milas**. KAI plugin package signatures are independent of Windows Authenticode signatures.

## Repository setup

Configure these Actions secrets in `therexdev/kai-core` using the existing Azure values, or grant this repository access to equivalent organization secrets:

| Secret | Purpose |
| --- | --- |
| `AZURE_SIGNING_ACCOUNT` | Existing Azure signing account name |
| `AZURE_SIGNING_PROFILE` | Existing certificate profile name |
| `AZURE_TENANT_ID` | Microsoft Entra tenant |
| `AZURE_CLIENT_ID` | Signing application's client ID |
| `AZURE_CLIENT_SECRET` | Signing application's credential |
| `AZURE_SIGNING_ENDPOINT` | Optional regional endpoint; defaults to `https://eus.codesigning.azure.net` |

Use GitHub **Settings → Secrets and variables → Actions**. Repository secrets from `kaiapp` are not automatically available to `kai-core`, and GitHub does not return saved secret values. Obtain the original values from their secure source; do not put them in source code, release notes, build logs or chat. The Azure identity must have permission to sign with the selected profile.

No new publisher identity is needed. The signing policy pins the established certificate subject, rather than a short-lived certificate's thumbprint:

```text
CN=Michael Milas, O=Michael Milas, L=Bennington, S=ne, C=US
```

## Release requirements

Windows CI fails if signing configuration is missing. It signs the installed app and Windows distributions, then verifies Authenticode trust, the publisher, timestamps and artifact hashes. Release publication verifies that the signature report belongs to the current commit and workflow and that the update metadata describes the exact verified installer. A published version is immutable; fixes require a new version.

Only the Windows `latest.yml` update feed and its verified installer assets are published for in-app installation. macOS, Linux and portable distributions retain manual installation with automatic release checks. Do not enable an automatic installation path for another platform without its platform-specific trust and lifecycle verification.

The updater accepts only the Core release source and newer stable versions. It verifies the download hash and expected Windows Authenticode publisher before installation. Missing or invalid verification blocks installation instead of falling back to running an unverified executable.

## User behavior

- Settings offers **Check for updates** and an automatic-check preference, enabled by default.
- Local-Only privacy pauses network update operations.
- The Windows Setup distribution offers **Download update**, followed by **Restart and install** after verification.
- Downloading does not install automatically. Normal exit and close-to-tray do not install updates.
- Restarting to install stops Core and its plugin services using the normal shutdown lifecycle.
- Core 0.7.7 and earlier require one manual installation of a version containing this updater.
- The application identity and profile paths stay unchanged. Updates do not migrate or replace user models, wallets or plugin data.

Signing establishes the verified publisher. A newly published file may still receive a separate Microsoft SmartScreen reputation warning.
