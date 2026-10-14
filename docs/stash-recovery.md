# Stash preparation and closure recovery

Stashing spans storage, alarm creation, and source-tab removal. The saved copy
must exist before removal, but it must not automatically reopen a source tab
whose closure was never confirmed.

## Order of operations

1. Capture and re-read the selected source tab, validate the duration/URL, then
   persist its saved copy as `status: "stashing"`. Repeat-last state stays intact.
2. Prepare its restore alarm. If that fails before closure, remove the new record
   and clear its alarm where possible; leave the source untouched.
3. Re-read the source by its current live ID. If it navigated, roll back and leave
   the changed tab open. If it cannot be checked, retain an inactive saved copy.
4. Request source removal. If it rejects and the same live source can still be
   read, roll back. If its closure cannot be established, retain the saved copy
   for review rather than discarding potentially the only remaining copy.
5. After successful removal, keep a live closure receipt. Atomically persist
   `scheduled` and `state.lastStashPresetMinutes` in one storage-root write using
   `setStashes(stashes, statePatch)`.
6. Re-arm the restore alarm in case it fired during closure. If that API fails,
   the scheduled record remains durable and the response reports `alarmPending`.
   The response supplies recovery feedback; reconciliation can repair a
   missing alarm on a later background load.

Rollback preserves other stashes and repeat-last metadata. If rollback or alarm
cleanup fails, any retained `stashing` record remains ineligible for automatic
restoration. A stale alarm cannot bypass that rule.

The atomic repeat-last patch includes `state.lastStashId`. Live request ordering
ensures that finishing an older pending stash cannot overwrite the preset of a
newer completed one, even if a storage write succeeded but its response failed.
This is an extension stash identifier, not a browser tab identifier. After the
context disappears, old uncertain entries require review rather than automatic
finalization.

## Pending completion and review

| State | Stash-list action | Behavior |
| --- | --- | --- |
| Durable `stashing`, with live closure receipt | **Finish scheduling** | Commit the known closure and repeat-last state, then re-arm; never close another tab |
| Durable `stashing`, without live receipt | **Restore saved copy** | Ask the user to check whether the original remains open; only the explicit action may create a tab |
| Durable `scheduled` | **Restore** | Normal scheduled/manual restoration and bounded creation retries |

`stashed` is a list-response status derived from the live receipt; it is never
persisted as proof of closure. The `finish-stash` message requires that receipt.
Once the background context is gone, an interrupted record is uncertain even if
its source actually closed. Reconciliation clears its alarm and retains the copy
for review without matching URLs/titles or interpreting an old tab ID.

Bulk restore and alarms can finalize a live confirmed closure before restoring,
but cannot implicitly approve an uncertain one. **Delete** dismisses the saved
record without removing a currently open tab. Review-approved copy restoration
then uses the normal restore intent/completion protocol.

This protocol reduces duplicate/loss risk without claiming a transaction across
Firefox APIs and storage. The final URL check does not make concurrent browser
navigation/removal atomic. Physical disk, process interruption, power loss, and
native popup behavior require separate evidence. The browser suite injects
selected API failures in its generated test package; production scripts and the
production manifest never load those test hooks.
