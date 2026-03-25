# Testing

## Automated tests

Run the unit test suite with:

```bash
npm test
```

These tests cover the pure restore-decision logic:
- stash restore metadata extraction
- restore window selection
- restore tab index clamping

## Browser verification

Use this manual matrix when behavior changes touch Firefox extension APIs.

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Restore to original window | Stash a normal web tab in window A and wait for restore. | The tab restores into window A. |
| Restore fallback window | Stash a normal web tab in window A, close window A before restore, then focus another Firefox window. | The tab restores into the focused fallback window. |
| Restore tab position | Stash a tab from the middle of a window with multiple tabs. | The restored tab returns at the same approximate index, or at the end if the window now has fewer tabs. |
| Preserve container | Stash a tab inside a Firefox Multi-Account Containers tab and wait for restore. | The restored tab keeps the original `cookieStoreId`. |
| Container fallback | Restore a stashed container tab in a situation where the original container cannot be reused. | The restore retries without `cookieStoreId` instead of failing outright. |
| Unsupported URL rejection | Try to stash an `about:` or other internal tab. | Backstash rejects the stash cleanly and does not schedule a restore. |
| Popup stash flow | Open the toolbar popup or the keyboard overlay command, enter a duration such as `15`, `15m`, `2h`, or `3d`, and submit. | Backstash closes the popup and schedules the tab with the parsed minute duration. |
| Popup invalid decimal | Open the popup, enter a decimal such as `2.3`, and submit. | Backstash keeps the popup open and shows an error explaining the supported duration formats. |
| Popup stash list | Open the popup while tabs are stashed. | The popup shows the current stashes with restore times in ascending scheduled order. |
| Popup restore now | Click `Restore now` on one listed stash. | The selected stash restores immediately and disappears from the list. |
| Popup restore all | Click `Restore all` in the popup. | All currently stashed tabs restore immediately and the list becomes empty. |
