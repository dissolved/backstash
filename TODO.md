# Backstash TODO

## Near-term priorities

### 1. Window-aware restore
- Restore a stashed tab to the same window it came from when that window still exists.
- Fall back gracefully if the original window is gone:
  - restore to the current window, or
  - restore to a new window if that proves to be a better UX.
- Preserve current container restore behavior while adding window targeting.
- Decide whether restored tabs should keep their original approximate tab position within the window.

### 2. Presets and keyboard-first stash workflow
- Replace the current single hardcoded stash duration with multiple built-in presets.
- Add at least one reliable keyboard shortcut for invoking Backstash.
- Decide whether shortcuts should:
  - directly trigger specific presets, or
  - open a lightweight Backstash picker/overlay.
- Preserve a toolbar-button path as a fallback.

### 3. Custom stash duration
- Allow entering an arbitrary duration instead of relying only on presets.
- Start with simple duration input such as:
  - minutes
  - hours
  - days
- Decide whether custom duration entry belongs in:
  - a popup,
  - an overlay,
  - or an options/settings page.

### 4. Absolute time/date restore
- Allow specifying a concrete restore time/date instead of only a duration.
- Support common cases first:
  - later today
  - tomorrow morning
  - specific date/time
- Decide on timezone behavior and how to present scheduled times clearly.
- Make sure absolute scheduling handles browser restarts cleanly.

## Medium priority

### 5. Same-tab-group restore (if Firefox API allows)
- Investigate whether Firefox exposes enough tab-group APIs to:
  - detect a tab's group when stashed
  - recreate or reattach to that group when restored
- If full group restore is not possible, document the limitation and preserve other context.
- Watch for API changes because Firefox tab groups are relatively new.

### 6. Notification improvements
- Keep restoring tabs in the background by default.
- Reduce notification spam when multiple tabs restore around the same time.
- Explore grouped/batched notifications within a short threshold window.
- Decide whether grouped notifications should summarize:
  - count only,
  - window name/context,
  - or individual tab titles.
- Keep click-to-focus for restored tabs on the backlog for now.

### 7. Settings model expansion
- Add schema-backed settings for:
  - `restoreInBackground`
  - `showNotifications`
  - default preset durations/times
  - notification grouping threshold
- Keep settings in the existing single-root storage model.
- Prepare for schema migration once settings become user-editable.

## Lower priority / backlog

### 8. Repeat last stash
- Add a fast action to repeat the most recent stash choice.
- Use the existing `state.lastStashPresetMinutes` field.
- Useful once multiple presets and custom durations exist.

### 9. Stash management UI
- Add a way to inspect currently stashed tabs.
- Support actions such as:
  - restore now
  - delete/cancel stash
  - edit scheduled restore time
- Show the scheduled restore date/time clearly in the UI.
- Support ad hoc selective restore before the scheduled time.
- Decide whether this lives in:
  - a popup,
  - an options page,
  - or a dedicated management page.

### 10. Smarter restore metadata
- Store and use more restore context where available:
  - original window ID
  - original tab index
  - tab group membership
  - restored tab ID
  - notification ID
- Add defensive handling when stored context is no longer valid.

### 11. Alarm/storage housekeeping
- Add startup reconciliation logic for cases where alarms and stored stashes drift apart.
- Detect orphaned alarms or orphaned stored stashes.
- Decide on behavior after browser restart, extension reload, or upgrade.

### 12. Publish-quality cleanup
- Improve icons and polish extension metadata.
- Review permissions and minimize them where possible.
- Expand linting and code organization as the codebase grows.
- Add release checklist before AMO submission.

## Open questions
- What is the primary interaction model for Backstash long-term?
  - one shortcut that opens a picker
  - or multiple direct-action shortcuts
- Should restored tabs go back to their original tab index, or simply the original window?
- If the original window no longer exists, what fallback is least surprising?
- If tab-group restore is unsupported, should Backstash surface that in UI/settings or simply fail silently?
- For absolute scheduling, what is the minimum viable input format that stays keyboard-friendly?

## Future considerations
- Low priority: support fractional minute durations.

## Nice-to-have implementation notes
- Keep using the terms `stash`, `stashed`, and `stashes` consistently throughout code and UI.
- Preserve Firefox Multi-Account Containers behavior by continuing to store and reuse `cookieStoreId`.
- Continue separating persistence concerns from behavior as features expand.
