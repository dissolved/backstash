# Restore recovery

Restore creation and cleanup are separate outcomes. Once Firefox returns a
created tab, failures while recording completion, clearing an alarm, or removing
the stash must not cause another automatic tab creation.

The existing per-stash `status` and `restoredTabId` fields record progress. The
storage root and schema version remain unchanged; legacy records without a
status are treated as scheduled. No URL/title matching or new permission is
needed.

| Stored status | Meaning | Allowed recovery |
| --- | --- | --- |
| `scheduled` or absent | No pending creation attempt | Normal restore; future bounded retry/backoff may apply |
| `restoring` | Intent persisted; creation outcome is unconfirmed | Keep visible for review; only an explicit **Restore again** action may create another tab |
| `restored` | Firefox returned a created tab; cleanup is pending | Retry alarm/storage cleanup only, even if the original tab has since closed |

## Order of operations

1. Persist `restoring` before calling `tabs.create`. If saving progress fails, do
   not request tab creation.
2. If tab creation rejects, return the stash to `scheduled`. If that reset cannot
   be saved, leave the uncertain record for review.
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
Actual process/power-loss durability, source-tab closure failure recovery, and
automatic retry delays remain separate work. Tests inject API failures in Node
and seed durable recovery states across a real Firefox extension reload; they
do not simulate a physical disk or power failure.
