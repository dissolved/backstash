const RESTORE_EVENT_PREFIX = "restore-stash:";
const restoreOperations = new Map();
let mutationQueue = Promise.resolve();

// Serialize complete state transitions, including their tab/alarm side effects.
// Only entry points enqueue; internal helpers must not enqueue and await another
// operation while holding the queue. A rejected operation must not block later work.
function enqueueMutation(operation) {
  const result = mutationQueue.then(operation);
  mutationQueue = result.catch(() => {});
  return result;
}

function enqueueActiveTabMutation(operation) {
  // Capture the target before waiting for earlier mutations, while reserving
  // queue order immediately. Handle query rejection even while the queue waits.
  const target = browser.tabs.query({ active: true, currentWindow: true }).then(
    tabs => ({ tab: tabs[0] }),
    error => ({ error }),
  );
  return enqueueMutation(async () => {
    const { tab, error } = await target;
    if (error) throw error;
    return operation(tab);
  });
}
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
    originalGroupId: Number.isInteger(tab.groupId) ? tab.groupId : null,
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

async function getRestoreAlarms() {
  const alarms = await browser.alarms.getAll();
  return alarms.filter((alarm) => alarm.name.startsWith(RESTORE_EVENT_PREFIX));
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
  return enqueueActiveTabMutation(tab => performStashActiveTab(minutes, tab));
}

async function performStashActiveTab(minutes, selectedTab) {
  if (!BackstashPresets.isValidDurationMinutes(minutes)) {
    const error = "Invalid stash duration; expected a positive whole number of minutes.";
    console.warn(error);
    return { ok: false, error };
  }

  if (!selectedTab) {
    const error = "No active tab found.";
    console.warn(error);
    return { ok: false, error };
  }

  // Re-read by identity: it may have navigated or closed while queued. Never
  // persist a second stash for a source tab that an earlier request closed.
  let tab;
  try {
    tab = await browser.tabs.get(selectedTab.id);
  } catch {
    return { ok: false, error: "The selected tab is no longer available." };
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
  return enqueueActiveTabMutation(performRepeatLastStash);
}

async function performRepeatLastStash(selectedTab) {
  const state = await getState();
  const minutes = BackstashPresets.getRepeatLastStashMinutes(state);

  if (minutes === null) {
    console.warn("No previous stash preset is available to repeat.");
    return;
  }

  return performStashActiveTab(minutes, selectedTab);
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

async function restoreTabGroupMembership(stashItem, restoredTab) {
  if (
    !browser.tabGroups ||
    !browser.tabs.group ||
    !Number.isInteger(stashItem.originalGroupId) ||
    stashItem.originalGroupId === browser.tabGroups.TAB_GROUP_ID_NONE
  ) {
    return;
  }

  try {
    const tabGroup = await browser.tabGroups.get(stashItem.originalGroupId);
    if (tabGroup.windowId !== restoredTab.windowId) {
      return;
    }

    await browser.tabs.group({
      groupId: stashItem.originalGroupId,
      tabIds: restoredTab.id,
    });
  } catch (error) {
    console.warn(
      "Original tab group is unavailable; restored tab will remain ungrouped.",
      error,
    );
  }
}

async function restoreStashItem(stashItem) {
  try {
    const restoredTab = await createRestoredTab(stashItem);
    await restoreTabGroupMembership(stashItem, restoredTab);
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

async function performRestoreStashById(stashId) {
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

/**
 * Restore a stashed tab when its alarm fires.
 */
async function restoreStashById(stashId) {
  const existingRestore = restoreOperations.get(stashId);
  if (existingRestore) {
    return existingRestore;
  }

  const restorePromise = enqueueMutation(() => performRestoreStashById(stashId)).finally(() => {
    restoreOperations.delete(stashId);
  });
  restoreOperations.set(stashId, restorePromise);
  return restorePromise;
}

async function restoreAllStashes() {
  return enqueueMutation(performRestoreAllStashes);
}

async function performRestoreAllStashes() {
  const stashes = await getStashes();
  if (stashes.length === 0) {
    console.warn("No stashed tabs are available to restore.");
    return {
      ok: false,
      restoredCount: 0,
      failedCount: 0,
    };
  }

  let failedCount = 0;
  let restoredCount = 0;

  for (const stashItem of stashes) {
    const result = await performRestoreStashById(stashItem.id);
    if (result.ok) {
      restoredCount += 1;
      continue;
    }

    failedCount += 1;
  }

  console.log(
    `Restore-all completed: ${restoredCount} restored, ${failedCount} remaining.`,
  );

  return {
    ok: restoredCount > 0,
    restoredCount,
    failedCount,
  };
}

async function reconcileScheduledStashes() {
  return enqueueMutation(performReconcileScheduledStashes);
}

async function performReconcileScheduledStashes() {
  const stashes = await getStashes();
  const alarms = await getRestoreAlarms();
  const stashIds = new Set(stashes.map((stashItem) => stashItem.id));
  const alarmNames = new Set(alarms.map((alarm) => alarm.name));

  let recreatedAlarmCount = 0;
  let clearedAlarmCount = 0;
  let dueRestoreCount = 0;

  for (const stashItem of stashes) {
    if (stashItem.wakeAt <= Date.now()) {
      dueRestoreCount += 1;
      await performRestoreStashById(stashItem.id);
      continue;
    }

    const alarmName = makeAlarmName(stashItem.id);
    if (!alarmNames.has(alarmName)) {
      await createRestoreAlarm(stashItem);
      recreatedAlarmCount += 1;
    }
  }

  for (const alarm of alarms) {
    const stashId = alarm.name.slice(RESTORE_EVENT_PREFIX.length);
    if (stashIds.has(stashId)) {
      continue;
    }

    await browser.alarms.clear(alarm.name);
    clearedAlarmCount += 1;
  }

  console.log(
    "Startup reconciliation complete:",
    JSON.stringify({
      recreatedAlarmCount,
      clearedAlarmCount,
      dueRestoreCount,
    }),
  );
}

async function listStashes() {
  const stashes = await getStashes();
  return stashes
    .slice()
    .sort((left, right) => left.wakeAt - right.wakeAt)
    .map((stashItem) => ({
      id: stashItem.id,
      title: stashItem.title,
      url: stashItem.url,
      wakeAt: stashItem.wakeAt,
    }));
}

async function cancelStashById(stashId) {
  return enqueueMutation(() => performCancelStashById(stashId));
}

async function performCancelStashById(stashId) {
  const stashes = await getStashes();
  const stashExists = stashes.some((item) => item.id === stashId);

  if (!stashExists) {
    console.warn("No stashed item found for cancel:", stashId);
    return {
      ok: false,
      error: "No stashed item found.",
    };
  }

  const remaining = stashes.filter((item) => item.id !== stashId);
  await setStashes(remaining);
  await clearRestoreAlarm(stashId);

  return { ok: true };
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
  if (message?.type === "stash-for-minutes") {
    return stashActiveTab(message.minutes);
  }

  if (message?.type === "list-stashes") {
    return listStashes();
  }

  if (message?.type === "restore-stash-now") {
    return restoreStashById(message.stashId);
  }

  if (message?.type === "cancel-stash") {
    return cancelStashById(message.stashId);
  }

  if (message?.type === "restore-all-stashes") {
    return restoreAllStashes();
  }

  return false;
});

browser.runtime.onStartup.addListener(() => {
  reconcileScheduledStashes().catch((error) => {
    console.error("Failed during startup reconciliation:", error);
  });
});

reconcileScheduledStashes().catch((error) => {
  console.error("Failed during extension load reconciliation:", error);
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

if (typeof module !== "undefined") {
  module.exports = {
    makeAlarmName,
    getRestoreAlarms,
    restoreStashById,
    reconcileScheduledStashes,
    __testing: {
      restoreOperations,
      performRestoreStashById,
      restoreStashItem,
    },
  };
}
