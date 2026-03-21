// Backstash (PoC)
// Minimal behavior:
// 1. User clicks the toolbar button
// 2. We read the active tab
// 3. We save enough metadata to reopen it later
// 4. We create a 1-minute alarm
// 5. We close the tab
// 6. When the alarm fires, we recreate the tab

const STASH_MINUTES = 1;
const STORAGE_KEY = "stashedTabs";

/**
 * Read the current stashed-tab list from extension storage.
 * Returns an array.
 */
async function getStashedTabs() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] ?? [];
}

/**
 * Write the stashed-tab list back to storage.
 */
async function setStashedTabs(items) {
  await browser.storage.local.set({ [STORAGE_KEY]: items });
}

/**
 * Build a unique alarm name for one stashed tab.
 */
function makeAlarmName(itemId) {
  return `restore-tab:${itemId}`;
}

/**
 * Create a simple unique ID.
 * Good enough for a local proof of concept.
 */
function makeItemId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Stash the currently active tab for STASH_MINUTES.
 */
async function stashActiveTab() {
  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  const tab = tabs[0];
  if (!tab) {
    console.warn("No active tab found.");
    return;
  }

  // Skip tabs we probably shouldn't try to restore this way.
  // about:, moz-extension:, and some internal pages can be problematic.
  if (!tab.url || /^(about:|moz-extension:|chrome:)/.test(tab.url)) {
    console.warn("This tab type is not supported for stashing:", tab.url);
    return;
  }

  const itemId = makeItemId();
  const wakeAt = Date.now() + STASH_MINUTES * 60 * 1000;

  const stashedItem = {
    id: itemId,
    url: tab.url,
    title: tab.title ?? tab.url,
    originalWindowId: tab.windowId,
    createdAt: Date.now(),
    wakeAt,
  };

  const existing = await getStashedTabs();
  existing.push(stashedItem);
  await setStashedTabs(existing);

  // Create an alarm that will fire at the wake time.
  await browser.alarms.create(makeAlarmName(itemId), {
    when: wakeAt,
  });

  // Close the tab after state is saved.
  await browser.tabs.remove(tab.id);

  console.log(
    `Stashed tab "${stashedItem.title}" until ${new Date(wakeAt).toLocaleTimeString()}`,
  );
}

/**
 * Restore a stashed tab when its alarm fires.
 */
async function restoreStashedTabById(itemId) {
  const existing = await getStashedTabs();
  const item = existing.find((x) => x.id === itemId);

  if (!item) {
    console.warn("No stashed item found for ID:", itemId);
    return;
  }

  try {
    // For the PoC, just reopen in a normal new foreground tab.
    await browser.tabs.create({
      url: item.url,
      active: true,
    });
  } catch (error) {
    console.error("Failed to restore tab:", item.url, error);
    return;
  }

  // Remove restored item from storage.
  const remaining = existing.filter((x) => x.id !== itemId);
  await setStashedTabs(remaining);

  console.log(`Restored tab "${item.title}"`);
}

/**
 * Toolbar button click handler.
 */
browser.action.onClicked.addListener(async () => {
  try {
    await stashActiveTab();
  } catch (error) {
    console.error("Failed to stash active tab:", error);
  }
});

/**
 * Alarm handler.
 */
browser.alarms.onAlarm.addListener(async (alarm) => {
  const prefix = "restore-tab:";
  if (!alarm.name.startsWith(prefix)) {
    return;
  }

  const itemId = alarm.name.slice(prefix.length);

  try {
    await restoreStashedTabById(itemId);
  } catch (error) {
    console.error("Failed while handling alarm:", alarm.name, error);
  }
});
