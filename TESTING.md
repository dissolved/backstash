# Testing

## Fast automated checks

```sh
npm test
npm run lint
```

Node tests exercise production scripts with isolated browser interfaces, plus pure duration/preset and restore-decision logic. Coverage includes window selection/index clamping, command routing, same-stash restore deduplication, reconciliation/idempotence, failed-restore recovery, persistence before tab closure, storage-write failure, cancellation, partial restore-all failure, and notification failure/settings. Deferred API responses force overlap between distinct restores, restore-all, cancellation, stash/repeat-last, and reconciliation, checking tab counts, retained state, alarm cleanup, queue recovery after rejection, and captured target identity even when focus changes or a source tab closes. Fake browser interfaces cannot establish actual Firefox API behavior.

## Automated Firefox checks

Following [Tabometer's approach](https://github.com/dissolved/tabometer), the runner uses [Mozilla Marionette](https://firefox-source-docs.mozilla.org/python/marionette_driver.html), a disposable profile, and loopback fixture pages. Install Firefox desktop and [uv](https://docs.astral.sh/uv/), then run:

```sh
npm run test:firefox
# Quicker partial run:
npm run test:firefox -- --skip-alarm
# Override the binary or show the test browser:
uv run scripts/firefox-checks.py --firefox /path/to/firefox --headed
# Actual browser restart with an unsigned persistent installation:
uv run scripts/firefox-checks.py --firefox '/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox' --restart
```

uv supplies the inline test-only dependency `marionette-driver==3.7.1`. Firefox is found on PATH or at its usual macOS location. The runner packages an explicit allowlist of unchanged production files plus a test-only scenario module. It never uses your everyday profile, browsing data or accounts. It removes the owned profile/package afterward, reports failures with a nonzero exit status, and prints recent Firefox logs on failure. The fixture server binds only to loopback. Firefox itself may make unrelated service requests; this suite does not assert zero browser network traffic.

The runner enables remote system access only in the test process. `--restart` requires a Firefox build that supports disabling signature enforcement, typically Developer Edition/Nightly; see [Mozilla's persistent/restart testing guidance](https://extensionworkshop.com/documentation/develop/testing-persistent-and-restart-features/). Default temporary installs cannot survive browser exit and explicitly skip restart. The harness uses Firefox internals for reload and lifecycle observation; compatibility with older Firefox builds is separate from the extension's minimum version. Current browser scenarios require tab-group support and fail clearly if it is absent.

### Coverage replacing the former manual matrix

| Behavior | Automated check |
| --- | --- |
| Original window, approximate position and index clamping | Real tab creation/stash/restore in a separate window |
| Closed-window fallback | Close original window, focus controller window, verify restore target |
| Background restoration | Verify restored tab is inactive |
| Container preservation | Stash/restore a built-in Firefox container tab |
| Missing container fallback | Seed an unavailable container ID, verify successful default-container restore |
| Existing/missing tab groups | Preserve an existing real group, then remove group and verify ungrouped fallback |
| Unsupported internal URLs and invalid duration messages | Verify rejection leaves storage/alarms empty |
| Popup duration entry and feedback | Submit `15`, `15m`, `2h`, `3d`; reject decimal input |
| Popup sorted list, restore, delete, restore all | Operate actual production DOM controls and verify storage, alarms, and tabs |
| Concurrent messages | Overlap cancel, individual/bulk restores, and a new stash; verify exactly one tab per restored stash, no cancelled tab, retained new stash/repeat-last state, and matching alarms |
| Restore recovery | Seed completed/uncertain progress, test popup cleanup, reload the extension, then verify cleanup-only reconciliation, suppressed uncertain retries, bulk feedback, explicit retry, and dismissal without closing an open tab |
| Extension reload reconciliation | Actual add-on reload with missing/orphan alarms and an overdue stash; verify exactly one overdue tab |
| Background lifecycle | Observe natural suspension from the parent process, then verify message wake preserves stash/state and recreates its missing alarm |
| Scheduled restore | Real one-minute alarm and elapsed wall time; explicitly skipped with `--skip-alarm` |
| Browser restart reconciliation | Optional `--restart`: retained stashes, missing alarm recreation, orphan removal, overdue restoration |

Popup tests render the production popup page in a browser tab and suppress only `window.close` during successful submission so the assertions can continue. They assert that close was requested. Native toolbar anchoring, actual popup dismissal, and OS shortcut delivery remain presentation/input checks. Command dispatch itself is covered by Node tests. Notification failure and disabled/foreground settings are covered by Node tests; operating-system notification presentation is not asserted.

## Remaining manual or unverified checks

- OS sleep/wake: stash a tab, sleep past its due time, wake, and check it restores once. Fake clock advancement and browser restart do not establish OS wake behavior.
- Native toolbar popup placement/dismissal, shortcut conflicts, visual light/dark presentation, keyboard navigation and screen-reader usability.
- OS notification delivery/presentation where enabled.
- Upgrade/schema migration, minimum-version Firefox, physical disk/quota exhaustion and process/power loss are not yet browser-tested.
- Browser restart remains unverified until a `--restart` run is recorded below. Temporary extension reload is a different check.

Do not repeat the automated matrix manually after a passing run unless diagnosing a browser/profile-specific issue. Extend the suite when adding behavior; retain manual checks only where automation does not establish the result.

## Recorded results

### 2026-10-14 — Restore recovery

- All 51 Node tests passed; ESLint and whitespace checks passed. The ten new
  restore recovery cases fail against the preceding background implementation.
  Injected failures cover progress/completion/removal writes, storage reads,
  alarm cleanup, failed-creation reset, and mixed bulk outcomes. A fresh VM
  background verifies that persisted recovery state outlives in-memory receipts.
- The quick Firefox run passed, explicitly skipping the real alarm. A final
  `npm run test:firefox` full headless macOS Firefox 158.0 run passed the real
  one-minute alarm, concurrency, normal popup/window/container/group checks,
  natural suspension/message wake, and actual extension reload/reconciliation.
- Added browser recovery checks seed completed and uncertain records, exercise
  **Finish cleanup**, reload the actual extension, verify no automatic duplicate
  creation or uncertain rearming, and exercise bulk feedback, **Restore again**,
  and **Delete** without closing an already reopened tab.
- These browser checks seed durable states rather than causing real disk failure
  or killing Firefox mid-operation. Browser restart was explicitly skipped;
  OS sleep/wake, physical disk/power loss, and native presentation remain
  unverified. Automatic retry/backoff is not implemented in this block.

### 2026-10-14

- All 41 Node tests passed; ESLint and `git diff --check` passed.
- Eleven new concurrency/target-identity regression cases fail against the prior
  background implementation and pass with the shared mutation queue. Tests pause
  API responses to force overlapping requests rather than relying on timing.
- `npm run test:firefox`: full headless macOS Firefox 158.0 suite passed with the
  final queued-target implementation, including concurrent cancel/individual and
  bulk restore/new-stash messages, popup actions, windows/containers/groups,
  natural background suspension/message wake, actual extension reload, and the
  real one-minute restore alarm.
- Browser restart was explicitly skipped (no `--restart` run). OS sleep/wake and
  native presentation/usability checks were not performed.
- Coordination applies to state-changing entry points in the running background
  context. Actions execute in queue order: an earlier cancellation prevents a
  later restore; cancellation queued after a restore cannot undo its created tab.
  Stash commands retain their initially selected tab identity and reject it if
  closed before execution. The queue is not a transaction across Firefox tabs,
  alarms, and storage; recovery from partial failures or process interruption
  remains a separate reliability task.

### 2026-10-13

- All 30 Node tests passed; ESLint and `git diff --check` passed.
- Headless macOS Firefox 157.0.1: full default suite passed in a disposable profile, including natural background suspension/message wake, windows/index fallback, containers, groups, popup actions, rejected inputs, actual extension reload/reconciliation, and a real one-minute alarm.
- A final `--skip-alarm` run passed after strengthening popup ordering with distinct fixture titles and reversed stored order, and making lifecycle fixture URLs unique. The alarm had already passed in the full run; it was explicitly skipped in this follow-up.
- Browser restart was explicitly skipped: Developer Edition/Nightly was not installed. The optional `--restart` path is implemented but unverified. OS sleep/wake, native popup/shortcut presentation, OS notification presentation, and manual usability/accessibility review were not performed.
- Initial harness failures came from treating a new tab's initial `about:blank`/complete state as a loaded fixture and retaining a discarded automation context after extension reload. Fixture URL/load synchronization and controller reselection corrected those harness issues; no production behavior was changed.

A passing suite establishes only its exercised paths and Firefox version; it does not establish freedom from all scheduling/storage races.
