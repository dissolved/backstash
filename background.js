const RESTORE_EVENT_PREFIX = "restore-stash:";
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

async function clearRestoreAlarm(itemId) {
  await browser.alarms.clear(makeAlarmName(itemId));
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
    console.warn(
      "Could not determine restore tab index; appending instead.",
      error,
    );
    return null;
  }
}

/**
 * Stash the currently active tab for the provided duration in minutes.
 */
async function stashActiveTab(minutes) {
  if (!BackstashPresets.isValidDurationMinutes(minutes)) {
    const error = "Invalid stash duration; expected a positive whole number of minutes.";
    console.warn(error);
    return { ok: false, error };
  }

  const tabs = await browser.tabs.query({
    active: true,
    currentWindow: true,
  });

  const tab = tabs[0];
  if (!tab) {
    const error = "No active tab found.";
    console.warn(error);
    return { ok: false, error };
  }

  if (!isSupportedTabUrl(tab.url)) {
    const error = "This tab type cannot be stashed.";
    console.warn(error, tab.url);
    return { ok: false, error };
  }

  const wakeAt = Date.now() + minutes * 60 * 1000;
  const stashItem = buildStashItem(tab, wakeAt);

  const stashes = await getStashes();
  stashes.push(stashItem);
  await setStashes(stashes);

  await updateState({
    lastStashPresetMinutes: minutes,
  });

  await createRestoreAlarm(stashItem);
  await browser.tabs.remove(tab.id);

  console.log(
    `Stashed tab "${stashItem.title}" until ${new Date(wakeAt).toLocaleTimeString()}`,
  );

  return { ok: true };
}

async function repeatLastStash() {
  const state = await getState();
  const minutes = BackstashPresets.getRepeatLastStashMinutes(state);

  if (minutes === null) {
    console.warn("No previous stash preset is available to repeat.");
    return;
  }

  await stashActiveTab(minutes);
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

async function restoreStashItem(stashItem) {
  try {
    const restoredTab = await createRestoredTab(stashItem);
    const notificationId = await notifyStashRestored(stashItem);
    await clearRestoreAlarm(stashItem.id);

    console.log(
      `Restored "${stashItem.title}" in ${
        restoredTab.cookieStoreId ?? "default"
      } container.`,
    );

    return {
      ok: true,
      restoredTabId: restoredTab.id,
      notificationId,
    };
  } catch (error) {
    console.error("Failed to restore stash:", stashItem.url, error);
    return {
      ok: false,
      error,
    };
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

  const result = await restoreStashItem(stashItem);
  if (!result.ok) {
    return result;
  }

  const remaining = stashes.filter((item) => item.id !== stashId);
  await setStashes(remaining);

  return result;
}

async function restoreAllStashes() {
  const stashes = await getStashes();
  if (stashes.length === 0) {
    console.warn("No stashed tabs are available to restore.");
    return {
      ok: false,
      restoredCount: 0,
      failedCount: 0,
    };
  }

  const remaining = [];
  let restoredCount = 0;

  for (const stashItem of stashes) {
    const result = await restoreStashItem(stashItem);
    if (result.ok) {
      restoredCount += 1;
      continue;
    }

    remaining.push(stashItem);
  }

  await setStashes(remaining);

  console.log(
    `Restore-all completed: ${restoredCount} restored, ${remaining.length} remaining.`,
  );

  return {
    ok: restoredCount > 0,
    restoredCount,
    failedCount: remaining.length,
  };
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
 * Keyboard shortcut handler.
 */
browser.commands.onCommand.addListener(async (command) => {
  if (command === "open-stash-overlay") {
    await browser.action.openPopup();
    return;
  }

  if (command === "restore-all-stashes") {
    await restoreAllStashes();
    return;
  }

  if (command === "repeat-last-stash") {
    await repeatLastStash();
    return;
  }

  const settings = await getSettings();
  const minutes = BackstashPresets.getCommandStashPresetMinutes(
    command,
    settings,
  );

  if (minutes !== null) {
    await stashActiveTab(minutes);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "stash-for-minutes") {
    return false;
  }

  return stashActiveTab(message.minutes);
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
