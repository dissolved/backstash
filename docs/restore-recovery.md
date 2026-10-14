# Restore recovery

Restore creation and cleanup are separate outcomes. Once Firefox returns a
created tab, failures while recording completion, clearing an alarm, or removing
the stash must not cause another automatic tab creation.

The existing per-stash `status` and `restoredTabId` fields record progress. The
storage root and schema version remain unchanged; legacy records without a
status are treated as scheduled. Optional `restoreFailureCount` and `nextRetryAt`
fields record the retry budget and timing; missing fields mean no prior failure.
No URL/title matching or new permission is needed.

Stash preparation also uses an inactive `stashing` state before source closure
is committed. Its review and scheduling rules are in [Stash recovery](stash-recovery.md).

| Stored status | Meaning | Allowed recovery |
| --- | --- | --- |
| `scheduled` or absent | No pending creation attempt | Restore when due; known creation failures use bounded automatic retries |
| `restoring` | Intent persisted; creation outcome is unconfirmed | Keep visible for review; only an explicit **Restore again** action may create another tab |
| `restored` | Firefox returned a created tab; cleanup is pending | Retry alarm/storage cleanup only, even if the original tab has since closed |

## Order of operations

1. Persist `restoring` before calling `tabs.create`. If saving progress fails, do
   not request tab creation.
2. If tab creation rejects, return the stash to `scheduled` with its incremented
   failure count and next retry time, then arm its retry alarm. If that state
   cannot be saved, leave the uncertain record for review without arming a retry.
3. If creation succeeds, retain an in-memory completion receipt immediately, then
   persist `restored` with the returned tab ID. If that write fails, the live
   receipt still prevents another creation in the current background context.
4. Clear the restore alarm, then remove the completed stash. A failure retains
   enough progress to retry cleanup through the popup, reconciliation, or an
   existing alarm. Group restoration and notifications are best-effort and cannot
   turn successful creation into a failed creation result.

A successful creation returns `ok: true`; `cleanupPending: true` means an alarm
or storage step remains incomplete. Bulk results count these separately in
`cleanupPendingCount`. They do not count as failed creations.

## Reload and user recovery

Reconciliation handles `restored` records regardless of their original due time,
without interpreting the saved tab ID as a currently valid browser identity.
It clears alarms for `restoring` records without rearming or reopening them.
Bulk restore also skips uncertain attempts.

If the background disappears after creation but before completion can be saved,
its live receipt is lost. The durable intent remains uncertain. The popup asks
the user to check their tabs before **Restore again**; that action sends an
explicit `confirmRestore: true`. **Delete** dismisses the entry without closing
an open tab. Confirmed records offer **Finish cleanup**, which never creates a tab.

This favors avoiding automatic duplicates when the result cannot be established.
The APIs do not provide a transaction spanning tab creation, alarms, and storage.
Actual process/power-loss durability remains unverified. Tests inject API failures
in Node and seed durable recovery
states across a real Firefox extension reload; they do not simulate a physical
disk or power failure.

## Automatic retries

Only known creation failures receive automatic retries. Delays are measured from
each failed attempt, so a late retry never triggers a burst of catch-up attempts.

| Consecutive known failures | Next automatic action |
| --- | --- |
| 1 | Retry after 1 minute |
| 2 | Retry after 5 minutes |
| 3 | Retry after 15 minutes |
| 4 | Stop; retain the stash for manual Restore |

The original `wakeAt` stays intact. Reconciliation uses `nextRetryAt` for failed
scheduled stashes, repairs missing or incorrectly timed alarms, and runs one
overdue attempt. Reloading does not reset the budget or bypass the delay. Early
or stale alarms cannot force another creation before it is due or after
exhaustion. Completion receipts/records remain cleanup-only; uncertain records
still require explicit review.

A manual Restore, including restore-all, can run before the next retry time or
after exhaustion. Its failure starts a fresh cycle with the one-minute delay.
The popup displays pending retry timing or exhaustion. Delete removes the stash
and its retry alarm. A successful creation clears retry timing before cleanup.

If retry metadata saves but arming its alarm fails, the error response offers
manual Restore; the saved retry timing can be repaired on the next background
load. The code does not claim the retry is armed in that case. Failure to clear
an exhausted alarm cannot restart its budget.
