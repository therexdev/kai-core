# KAI Core Beta 0.7.8

Settings now checks for Core updates and can check automatically in the background. A badge on Settings makes new releases visible, with the current version, update status and download progress in the app.

The installed Windows Setup version can download a verified update, then offers **Restart and install** when you are ready. Updates do not restart KAI automatically, install on normal exit, or interrupt work while KAI stays in the tray. Local-Only privacy pauses update checks and downloads. Portable, macOS and Linux builds check for new releases and open the official downloads page for manual installation.

Windows releases use the established **Michael Milas** Azure signing identity. Publication requires valid signatures, trusted timestamps, matching publisher and verified installer hashes. The in-app updater verifies the expected publisher and download before installation.

Install this version manually if you are on 0.7.7 or earlier. Your Core profile, wallet, models and installed plugins stay in place. Plugin updates continue to be managed separately in Plugins.
