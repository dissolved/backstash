# Working on Backstash

## Purpose and scope

Backstash is an early-development Firefox WebExtension that temporarily closes
tabs and restores them later. Preserve its small, privacy-conscious design and
keyboard-first workflow. Browsing data stays in local extension storage.

This file applies to the whole repository. Read `README.md` for the user-facing
overview, `TODO.md` for priorities, and `TESTING.md` for validation coverage and
known limitations. Check the working tree before editing and preserve unrelated
user changes. When returning after a gap, inspect these documents, recent Git
history, and relevant code before proposing changes.

## Project map

- `manifest.json`: Firefox Manifest V3 configuration, permissions, background
  script order, popup, and keyboard commands.
- `background.js`: stash/restore orchestration, alarms, reconciliation,
  notifications, and message/command handlers.
- `storage.js`: local persistence under the single `backstash` root, containing
  `schemaVersion`, `stashes`, `settings`, and `state`.
- `constants.js`: shared defaults.
- `restore-logic.js`: testable window-selection and tab-position helpers.
- `stash-presets.js`: duration parsing, preset selection, and command helpers.
- `stash-popup.html`, `stash-popup.css`, `stash-popup.js`: popup interface.
- `assets/icons/`: user-selected source artwork, asset notes, and sized PNGs
  for the extension listing and toolbar. Regenerate sized files from the source
  when changing artwork; only manifest-referenced sizes belong in packages.
- `tests/*.test.js`: Node tests for helpers and production scripts with isolated
  browser interfaces.
- `scripts/firefox-checks.py` and `tests/firefox/scenarios.js`: disposable-profile
  Firefox automation using Marionette and loopback fixture pages.

There is no build step or application framework. Browser scripts share globals
through manifest/HTML script ordering; some helpers also export CommonJS modules
for Node tests. Preserve both execution environments. Follow the existing plain
JavaScript style and avoid new tooling or runtime dependencies without a concrete
need.

## Behavior and design safeguards

- Persist a stash before closing its source tab. A failed persistence operation
  must not cause tab loss.
- Preserve the original container, window, approximate position, and existing
  tab group where possible; retain graceful fallbacks when they are unavailable.
  Background restoration should respect the stored setting.
- Treat stored state as durable and background memory as disposable. Firefox can
  suspend the background context; alarms and state must reconcile after reload
  or startup.
- Reconciliation already recreates missing alarms, removes orphan restore
  alarms, and restores overdue stashes. Individual concurrent restores for the
  same stash already share one operation. All background mutations run through
  one queue, including restore-all, cancellation, repeat-last, and reconciliation.
  Keep new state-changing entry points on that queue; helpers called from inside
  it must not enqueue and await another operation (that would deadlock).
  Capture stash target identity before waiting, then re-read that tab before
  persisting/closing it. The queue orders live requests; it does not provide
  crash-safe transactions across storage, tab creation/removal, and alarms.
- Failed restores retain their stashes for retry. Avoid changing failure paths
  in ways that discard recoverable data or create duplicate tabs.
- Restore records use `scheduled` (also the default for legacy records),
  `restoring` (outcome unconfirmed), and `restored` (creation confirmed, cleanup
  pending). Persist intent before creating a tab. Confirmed records and live
  completion receipts must only retry cleanup; uncertain records require the
  user's explicit "Restore again" action. Bulk restore, alarms, and reconciliation
  must never implicitly confirm uncertain attempts. Do not infer success by
  matching URLs/titles or by looking up a tab ID from a previous browser session.
  Scheduled creation failures get three automatic retries after 1, 5, and 15
  minutes. Persist `restoreFailureCount` and `nextRetryAt` before arming an alarm;
  alarms/reconciliation must respect both timing and exhaustion. Manual Restore
  (including restore-all) starts a fresh cycle. Do not replace the original
  `wakeAt` with retry timing or use in-memory timers for durable scheduling.
  See `docs/restore-recovery.md` before changing this protocol or retry policy.
- Keep settings and state in the existing storage root. Plan migration and
  compatibility explicitly when changing the schema.
- Keep permissions and exposure of URLs/titles minimal. Do not add telemetry,
  remote data storage, or external services without an explicit project decision.
- The external listener API is planned, not implemented. Any future integration
  must be generic and versioned: Backstash must not depend on Tabometer-specific
  behavior. Validate sender identity and payloads, define access/consent and
  reconnect/reconciliation behavior, and keep listener failures from blocking
  core operations. Do not promise exactly-once event delivery.

## Development and validation

Use Node.js and npm; `.tool-versions` records the project's Node version.
Install dependencies with `npm ci` when a clean installation is needed.

```sh
npm test
npm run lint
git diff --check
```

Run the fast checks for production JavaScript changes. Add meaningful regression
coverage when changing behavior, especially persistence, concurrency, scheduling,
and failure recovery. Documentation-only edits normally need a diff review and
`git diff --check`, not browser tests.

For Firefox API, lifecycle, or popup behavior, also use the existing browser
runner (requires Firefox desktop and `uv`):

```sh
npm run test:firefox
npm run test:firefox -- --skip-alarm
```

The second command is a partial run that skips the real one-minute alarm. Use the
full run when validating scheduling. See `TESTING.md` for binary overrides,
headed mode, and optional restart checks requiring a compatible Firefox build.
Always use the disposable test profile, never the user's everyday profile.

Extend automation alongside features to minimize manual testing. Fake browser
interfaces do not prove real Firefox behavior; temporary extension reload does
not prove browser restart. Keep OS sleep/wake, native popup/shortcut and
notification presentation, and usability/accessibility claims tied to actual
evidence. A passing run on one Firefox version does not validate the manifest's
minimum supported version or establish AMO publication readiness.

The Firefox harness packages an explicit production-file allowlist. Update it
when adding required runtime files or manifest-referenced assets, and keep test
fixtures out of release packages. When debugging the harness, wait for the exact
fixture URL to load and reselect a valid browser context after extension reload.

## Documentation and delivery

Keep `README.md` concise and practical. Put roadmap changes in `TODO.md` and
validation instructions/results in `TESTING.md`; distinguish implemented,
planned, and unverified behavior. Keep extension/package versions consistent
when changing release metadata. The project is MIT licensed; preserve third-party
license metadata.

When a logical block of uncommitted work is complete, reviewed, and appropriately
validated, proactively offer the user these choices:

1. Proceed — stage and commit the identified block.
2. Show diff — show the proposed commit's diff for review, then offer the choices
   again.
3. Not at this time — leave the work uncommitted and continue; do not repeatedly
   prompt for the same unchanged block.

Briefly identify the proposed block and its validation when offering the choices.
Wait for the user's selection before committing, unless they already explicitly
requested that commit. Approval to proceed authorizes only the identified commit;
pushing, publishing, and AMO submission require their own authorization.
When asked to commit/push, inspect and validate the intended staged diff, preserve
unrelated changes, and report the resulting commit and working-tree status.

## Keep this file current

As part of relevant work, update `AGENTS.md` whenever architecture, development
commands, testing workflow, durable project decisions, or these safeguards
change. Correct obsolete guidance in the same change that makes it obsolete.
If a repeated issue reveals a useful project-specific lesson, add a brief,
actionable instruction here once verified.

Keep this file focused on durable guidance for future work. Do not turn it into
a session log or duplicate the detailed roadmap and recorded test results.
Before finishing a task, check whether this file and the related documentation
need an update; no edit is necessary when the guidance remains accurate.
