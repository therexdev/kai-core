# Purchase progress and pending recovery

Core 0.7.41's purchase controller already emitted detailed progress and checked
saved payments in the background. The Foundation preload did not expose those
events, and Buy displayed the returned `pending` state as plain text. This change
connects the existing progress to Buy credits and Credits and Usage.

The status card shows approval, submission, confirmation, credit registration,
and cancellation separately, with elapsed time, last update and the public
transaction ID when available. A stale or failed check stops the activity
indicator. An expired quote or a saved signature requiring review explains the
next step. Buy stays disabled while the saved purchase remains unresolved;
recovery continues through the existing native approval path.

Two reporting fixes support this display:

- Background confirmation errors and timeouts report a bounded status. An
  intentional stop for foreground work or a privacy change does not report a
  payment failure.
- Re-registering an older funded receipt cannot complete progress for a newer
  pending purchase. Receipt registration itself is unchanged.

The renderer reads purchase status; the existing main-process synchronization
timer remains responsible for reconciliation. Status reads do not sign or
submit transactions. Payment approval, exact saved envelopes, cancellation,
nonce coordination, quote rules, credit accounting and journal storage retain
their existing behavior. Switching wallets or privacy mode discards stale UI
responses.

## Verification

- `npm test`: 805 passed, including 12 purchase progress regression tests.
- `npm run test:services` without the optional backend: 44 passed, 17 skipped.
- The payment integration subset passed all 9 tests using the CI-pinned backend
  `therexdev/kai@661c59ab9552bf38783034f168b78ae6912b1dec`; it exercises original
  Alpha journal recovery, reviewed purchases through $1,000, included payments
  surviving quote expiry and restart, and recovery without a duplicate signature
  or charge.
- `npm run test:foundation-native`: passed on Linux.
- `KAI_SMOKE_SYNTHETIC_LOCK=1 npm run test:credit-reconnect`: passed against
  source and the generated production closure. The fixture exercises the real
  Core UI, preload, registered IPC and sanitized event bridge. It covers
  navigation/reload, repeated Buy, delayed confirmation, expired quotes, and
  cancellation. Wallet, keychain, network/payment lifecycle and single-instance
  lock are synthetic. This environment blocks the normal singleton Unix socket.
- `npm run build:manifest` and `git diff --check`: passed.

These checks do not verify a live payment or a signed Windows installer.
Diagnosing an individual stalled purchase still requires its saved transaction
and confirmation evidence. A clearer status display does not establish the
cause of a stalled submission. The app changes are not a production deployment.
