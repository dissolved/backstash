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
 * Stash the currently active tab for provided minutes.
 */
async function stashActiveTab(minutes) {
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
  const wakeAt = Date.now() + minutes * 60 * 1000;

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
    // Reopen in a normal new background tab.
    // TODO: Ensure tab is restored in the same container from which it was stashed
    const restoredTab = await browser.tabs.create({
      url: item.url,
      active: false,
    });

    await notifyTabRestored(item);
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
 * Notify tab has been restored
 */
async function notifyTabRestored(item) {
  try {
    await browser.notifications.create(`restored:${item.id}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("icons/backstash-48.png"),
      title: "Backstash restored a tab",
      message: item.title ?? item.url,
    });
  } catch (error) {
    console.error("Failed to show notification:", error);
  }
}

/**
 * Toolbar button click handler.
 */
browser.action.onClicked.addListener(async () => {
  try {
    await stashActiveTab(1);
  } catch (error) {
    console.error("Failed to stash active tab:", error);
  }
});

/**
 * Keyboard shortcut handler.
 */
browser.commands.onCommand.addListener((command) => {
  if (command === "stash-1m") {
    stashActiveTab(1);
  } else if (command === "stash-5m") {
    stashActiveTab(5);
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
