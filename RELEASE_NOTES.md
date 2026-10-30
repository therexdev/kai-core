# KAI Foundation 0.7.1

Settings now ends with **Migrate from Koinos AI Alpha**. Click **Migrate**, select **Models**, **Wallet**, or both, and copy the selected items into KAI Core. Core detects the standard Alpha profile; **Choose folder** supports custom locations.

Close Alpha, including its tray process, before migrating. Models are copied into Core with progress and cancellation. Recognized catalog weights and vision projectors retain Core's required filenames; imported models receive their own Core paths. Existing Core files are preserved. Generated runtime caches are rebuilt when needed instead of duplicating them.

The wallet stays encrypted and locked with the same address and password. Unlock it in Core using the Alpha wallet password after migration. An existing Core wallet is never replaced. Wallet copying checks the encrypted file structure; normal unlock verifies the password and wallet identity.

Alpha's original files are unchanged. Plugin data, documents, connected accounts, settings, session keys and credentials are excluded. The Koinos Node plugin's separate wallet is not imported.

Install the Windows Setup build for a normal installation or Portable to launch without installing. Core updates remain manual; no automatic update feed is published.

Validation covers selective copies, wallet encryption compatibility, existing-data protection, cancellation, model hashes and metadata, and the actual Settings popup in Electron using disposable profiles and a test wallet. It does not exercise live blockchain transactions.
