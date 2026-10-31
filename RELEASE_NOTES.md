# KAI Core Beta 0.7.12

Earn shows **Daily Estimated Earnings** and **Drop Date: Nov 15, 2026**, with the extra text removed from the two reward summary boxes. The drop amount still uses 1 KOIN per 5 KAI. While Earn is open it checks verified rewards every five seconds; other visible pages keep the existing fifteen-second refresh. Availability is recorded by the network in one-minute intervals after its heartbeat validation window, so the app displays real increments without inventing per-block earnings. Polling pauses while Core is hidden in the tray.

The Core Wallet Send button now opens a styled dialog with a token selector, recipient, amount and password. **Send All** reads a fresh balance and fills the currently sendable amount, preserving all eight decimal places and accounting for KOIN mana limits. It does not submit a transaction; the existing password check and exact transfer approval still apply. Update Koinos Node separately for its matching Send All button.

Validation includes Core/service regression tests, native Foundation and dialog checks, and a real Electron wallet dialog check with synthetic balances. No live funds were transferred by these tests.
