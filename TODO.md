# Backstash TODO

## Near-term priorities

### Alarm/storage housekeeping
- Add startup reconciliation logic for cases where alarms and stored stashes drift apart.
- Detect orphaned alarms or orphaned stored stashes.
- Decide on behavior after browser restart, extension reload, or upgrade.

### Extension Settings
- Add setting to allow choice between whether restored tabs should keep their original approximate tab position within the window or at the end of the current window.
- Add schema-backed settings for:
  - `restoreInBackground`
  - `showNotifications`
  - default preset durations/times
  - notification grouping threshold
- Keep settings in the existing single-root storage model.
- Prepare for schema migration once settings become user-editable.

### Tab context menu
- Right clicking on a tab should have menu-items for stashing the tab
- All presets should be included as menu-items (submenu?) selectable via the context menu
- There should also be a context aware menuitem to bring up the overlay UI

### Absolute time/date restore
- Allow specifying a concrete restore time/date instead of only a duration.
- Support common cases first:
  - later today
  - tomorrow morning
  - specific date/time
- Decide on timezone behavior and how to present scheduled times clearly.
- Make sure absolute scheduling handles browser restarts cleanly.

### Stash management UI
- Support actions such as:
  - delete/cancel stash
  - edit scheduled restore time

## Medium priority

### Context aware menu-item
- Right clicking on a tab should have menu-items for stashing the tab
- All presets should included as menu-items (submenu?) be selectable via the context menu
- There should also be a context aware menuitem to bring up the overlay UI

### Same-tab-group restore after browser restart (Exploratory, since groupId doesn't persist across restarts)
- Store group metadata (title, color, collapsed) when tab stashed
- On browser restart, attempt to repopulate correct groupId by matching metadata (if extension has an opportunity to respond to a restart or quit event prior to browser restart, we could bolster this behavior by documenting tab group metadata associated with existing groupId's, then update the groupId's on the startup event)

### Notification improvements
- Reduce notification spam when multiple tabs restore around the same time.
- Explore grouped/batched notifications within a short threshold window.
- Decide whether grouped notifications should summarize:
  - count only,
  - window name/context,
  - or individual tab titles.
- Keep click-to-focus for restored tabs on the backlog for now.

## Lower priority / backlog

### Publish-quality cleanup
- Improve icons and polish extension metadata.
- Review permissions and minimize them where possible.
- Expand linting and code organization as the codebase grows.
- Add release checklist before AMO submission.

## Exploratory / future considerations

### Restore in unloaded state (Exploratory)
- Investigate whether Firefox exposes enough control to restore tabs in an unloaded/discarded state to conserve resources.
- Determine whether unloaded restore would preserve the user expectations around restore timing and visibility.

### Centered command palette / overlay (Exploratory)
- Investigate whether Backstash should eventually offer an injected in-page command palette or other centered overlay experience, since the browser action popup cannot be positioned arbitrarily within the browser window.
- Compare this against keeping the current popup for toolbar use and reserving a centered overlay for keyboard-first workflows only.

### Fractional minute durations
- Low priority: support fractional minute durations.
