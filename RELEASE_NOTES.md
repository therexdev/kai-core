# KAI Core Beta 0.7.10

Fixes a Windows update-verification bug that could reject a valid, signed installer when Windows PowerShell printed first-use module progress or other diagnostics. The checker now suppresses progress and requires successful execution plus the full verified signature record. Publisher identity, Authenticode trust, timestamps, file identity, size and SHA-512 checks remain mandatory.

The checker also lets Windows PowerShell construct its own module search path, avoiding incompatible PowerShell 7 modules inherited through a parent application. This applies only to the checker process and does not change your Windows or PowerShell settings.

Signature-checker startup failures and timeouts now have distinct messages. Windows release checks also exercise the actual in-app verifier against the signed installers and reject unsigned, damaged and differently signed files.

If an older Core version displays the signature-check error, use this release's official Windows Setup installer once. The older checker cannot install its own fix reliably. Quit KAI from its tray menu before running Setup; existing Core profiles, wallets, models and plugin data remain in place. Subsequent updates use the corrected checker.
