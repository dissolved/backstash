const RESTORE_EVENT_PREFIX = "restore-stash:";
const DEFAULT_STASH_MINUTES = 1;
/**
 * Build a unique alarm name for one stashed tab.
 */
function makeAlarmName(itemId) {
  return RESTORE_EVENT_PREFIX + itemId;
}

/**
 * Create a simple unique ID.
 */
function makeItemId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * buildStashItem
 */
function buildStashItem(tab, wakeAt) {
  const restoreContext = buildStashRestoreContext(tab);

  return {
    id: makeItemId(),
    url: tab.url,
    title: tab.title ?? tab.url,
    createdAt: Date.now(),
    wakeAt,
    originalWindowId: restoreContext.originalWindowId,
    originalTabIndex: restoreContext.originalTabIndex,
    cookieStoreId: tab.cookieStoreId ?? null,
    status: "scheduled",
    restoredTabId: null,
    notificationId: null,
  };
}

// Skip tabs we probably shouldn't try to restore this way.
// about:, moz-extension:, and some internal pages can be problematic.
function isSupportedTabUrl(url) {
  return Boolean(url) && !/^(about:|moz-extension:|chrome:)/.test(url);
}

async function createRestoreAlarm(stashItem) {
  await browser.alarms.create(makeAlarmName(stashItem.id), {
    when: stashItem.wakeAt,
  });
}

async function getTargetWindowId(stashItem) {
  const existingWindowIds = [];

  if (stashItem.originalWindowId !== null) {
    try {
      await browser.windows.get(stashItem.originalWindowId);
      existingWindowIds.push(stashItem.originalWindowId);
    } catch (error) {
      console.warn(
        "Original window is no longer available; falling back to another window.",
        error,
      );
    }
  }

  try {
    const window = await browser.windows.getLastFocused();
    return chooseRestoreWindowId({
      originalWindowId: stashItem.originalWindowId,
      existingWindowIds,
      lastFocusedWindowId: window?.id ?? null,
    });
  } catch (error) {
    console.warn("Could not determine a fallback window for restore.", error);
    return chooseRestoreWindowId({
      originalWindowId: stashItem.originalWindowId,
      existingWindowIds,
      lastFocusedWindowId: null,
    });
  }
}

async function getRestoreIndex(windowId, originalTabIndex) {
  if (windowId === null) {
    return null;
  }

  try {
    const tabs = await browser.tabs.query({ windowId });
    return chooseRestoreTabIndex({
      originalTabIndex,
      tabCount: tabs.length,
    });
  } catch (error) {
    console.warn("Could not determine restore tab index; appending instead.", error);
    return null;
  }
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

  if (!isSupportedTabUrl(tab.url)) {
    console.warn("This tab type cannot be stashed:", tab.url);
    return;
  }

  const wakeAt = Date.now() + minutes * 60 * 1000;
  const stashItem = buildStashItem(tab, wakeAt);

  const stashes = await getStashes();
  stashes.push(stashItem);
  await setStashes(stashes);

  await updateState({
    lastStashPreset: {
      kind: "minutes",
      value: minutes,
    },
  });

  await createRestoreAlarm(stashItem);
  await browser.tabs.remove(tab.id);

  console.log(
    `Stashed tab "${stashItem.title}" until ${new Date(wakeAt).toLocaleTimeString()}`,
  );
}

async function createRestoredTab(stashItem) {
  const settings = await getSettings();
  const windowId = await getTargetWindowId(stashItem);
  const index = await getRestoreIndex(windowId, stashItem.originalTabIndex);

  const createOptions = {
    url: stashItem.url,
    active: !settings.restoreInBackground,
  };

  if (windowId !== null) {
    createOptions.windowId = windowId;
  }

  if (index !== null) {
    createOptions.index = index;
  }

  if (stashItem.cookieStoreId) {
    createOptions.cookieStoreId = stashItem.cookieStoreId;
  }

  try {
    return await browser.tabs.create(createOptions);
  } catch (error) {
    if (stashItem.cookieStoreId) {
      console.warn(
        "Failed to restore with original container; retrying without cookieStoreId.",
        error,
      );

      delete createOptions.cookieStoreId;
      return await browser.tabs.create(createOptions);
    }

    throw error;
  }
}

/**
 * Restore a stashed tab when its alarm fires.
 */
async function restoreStashById(stashId) {
  const stashes = await getStashes();
  const stashItem = stashes.find((item) => item.id === stashId);

  if (!stashItem) {
    console.warn("No stashed item found for ID:", stashId);
    return;
  }

  try {
    const restoredTab = await createRestoredTab(stashItem);
    const notificationId = await notifyStashRestored(stashItem);

    const remaining = stashes.filter((item) => item.id !== stashId);
    await setStashes(remaining);

    console.log(
      `Restored "${stashItem.title}" in ${
        restoredTab.cookieStoreId ?? "default"
      } container.`,
    );

    return {
      restoredTabId: restoredTab.id,
      notificationId,
    };
  } catch (error) {
    console.error("Failed to restore stash:", stashItem.url, error);
  }
}

/**
 * Notify tab has been restored
 */
async function notifyStashRestored(stashItem) {
  const settings = await getSettings();
  if (!settings.showNotifications) {
    return null;
  }

  const notificationId = `restored:${stashItem.id}`;

  try {
    await browser.notifications.create(notificationId, {
      type: "basic",
      title: "Backstash restored a tab",
      message: stashItem.title ?? stashItem.url,
    });
    return notificationId;
  } catch (error) {
    console.error("Failed to show notification:", error);
    return null;
  }
}

/**
 * Toolbar button click handler.
 */
browser.action.onClicked.addListener(async () => {
  try {
    await stashActiveTab(DEFAULT_STASH_MINUTES);
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
  if (!alarm.name.startsWith(RESTORE_EVENT_PREFIX)) {
    return;
  }

  const stashID = alarm.name.slice(RESTORE_EVENT_PREFIX.length);

  try {
    await restoreStashById(stashID);
  } catch (error) {
    console.error("Failed while handling alarm:", alarm.name, error);
  }
});

console.log("Backstash background loaded.");
