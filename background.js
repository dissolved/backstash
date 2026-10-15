const RESTORE_EVENT_PREFIX = "restore-stash:";
const RESTORE_RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000];
const restoreOperations = new Map();
// Protect confirmed creations if persisting their completion record fails.
// Durable "restoring" records cover uncertainty after this context disappears.
const completedRestores = new Map();
// Closure is known only in this live context until "scheduled" can be saved.
const closedStashes = new Map();
const stashOrders = new Map();
let nextStashOrder = 0;
let mutationQueue = Promise.resolve();

function pruneStashOrders() {
  if (closedStashes.size === 0) {
    stashOrders.clear();
    return;
  }

  // Pending closures still need their order. Keep only the newest completed
  // order as well: even after its stash is deleted/restored, lastStashId may
  // refer to it and must prevent an older completion from replacing its preset.
  let latestCompletedId = null;
  let latestCompletedOrder = 0;
  for (const [id, order] of stashOrders) {
    if (!closedStashes.has(id) && order > latestCompletedOrder) {
      latestCompletedId = id;
      latestCompletedOrder = order;
    }
  }
  for (const id of stashOrders.keys()) {
    if (!closedStashes.has(id) && id !== latestCompletedId) stashOrders.delete(id);
  }
}

// Serialize complete state transitions, including their tab/alarm side effects.
// Only entry points enqueue; internal helpers must not enqueue and await another
// operation while holding the queue. A rejected operation must not block later work.
function enqueueMutation(operation) {
  const result = mutationQueue.then(operation).finally(pruneStashOrders);
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
    status: "stashing",
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
    when: getRestoreDueAt(stashItem),
  });
}

function getRestoreFailureCount(stashItem) {
  return Number.isSafeInteger(stashItem.restoreFailureCount) && stashItem.restoreFailureCount > 0
    ? stashItem.restoreFailureCount : 0;
}

function getRestoreDueAt(stashItem) {
  const failures = getRestoreFailureCount(stashItem);
  if (!failures) return stashItem.wakeAt;
  if (failures > RESTORE_RETRY_DELAYS.length) return null;
  return Number.isFinite(stashItem.nextRetryAt) && stashItem.nextRetryAt > 0
    ? stashItem.nextRetryAt : null;
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
  await setStashes([...stashes, stashItem]);

  try {
    await createRestoreAlarm(stashItem);
  } catch (error) {
    console.warn("Stash preparation failed before tab closure:", error);
    return abandonStash(stashes, stashItem, "Could not schedule this stash. The source tab was left open.");
  }

  let source;
  try {
    source = await browser.tabs.get(tab.id);
  } catch {
    await clearPendingStashAlarm(stashItem.id);
    return { ok: false, stashSaved: true, error: "The source tab could not be checked. A saved copy was retained; check your tabs before restoring or deleting it." };
  }
  if (source.url !== tab.url) {
    return abandonStash(stashes, stashItem, "The source tab navigated while stashing. It was left open.");
  }

  try {
    await browser.tabs.remove(tab.id);
  } catch (error) {
    console.warn("Could not confirm source tab closure:", error);
    try {
      await browser.tabs.get(tab.id);
    } catch {
      await clearPendingStashAlarm(stashItem.id);
      return { ok: false, stashSaved: true, error: "Tab closure could not be confirmed. A saved copy was retained; check your tabs before restoring or deleting it." };
    }
    return abandonStash(stashes, stashItem, "Could not close the source tab. It was left open.");
  }

  closedStashes.set(stashItem.id, minutes);
  stashOrders.set(stashItem.id, ++nextStashOrder);
  return finishStash([...stashes, stashItem], stashItem, minutes);
}

async function clearPendingStashAlarm(stashId) {
  try {
    await clearRestoreAlarm(stashId);
  } catch (error) {
    // A retained "stashing" record remains ineligible even if its alarm fires.
    console.warn("Could not clear a pending stash alarm:", error);
  }
}

async function abandonStash(previousStashes, stashItem, error) {
  await clearPendingStashAlarm(stashItem.id);
  try {
    await setStashes(previousStashes);
    return { ok: false, error };
  } catch (cleanupError) {
    console.warn("Could not remove an incomplete stash:", cleanupError);
    return { ok: false, stashSaved: true, error: `${error} A saved copy remains in the stash list for review.` };
  }
}

async function finishStash(stashes, stashItem, minutes) {
  const scheduled = { ...stashItem, status: "scheduled" };
  try {
    // Commit closure and repeat-last metadata together, after confirmed removal.
    // Completing an older pending stash must not replace a newer preset.
    const state = await getState();
    const updatePreset = stashOrders.get(stashItem.id) >= (stashOrders.get(state.lastStashId) ?? 0);
    await setStashes(stashes.map(item => item.id === stashItem.id ? scheduled : item), updatePreset ? {
      lastStashPresetMinutes: minutes, lastStashId: stashItem.id,
    } : null);
  } catch (error) {
    console.warn("Source closed; stash finalization remains pending:", error);
    return { ok: false, stashSaved: true, error: "Tab saved, but scheduling is incomplete. Choose Finish scheduling in the stash list." };
  }
  closedStashes.delete(stashItem.id);
  try {
    // Re-arm after the commit in case the first alarm fired during tab closure.
    await createRestoreAlarm(scheduled);
  } catch (error) {
    console.warn("Tab saved; restore alarm could not be confirmed:", error);
    return { ok: true, alarmPending: true, error: "Tab saved, but its restore alarm could not be confirmed. Restore it manually or reload Backstash to check the schedule." };
  }

  console.log(
    `Stashed tab "${stashItem.title}" until ${new Date(stashItem.wakeAt).toLocaleTimeString()}`,
  );

  return { ok: true };
}

async function finishStashById(stashId) {
  return enqueueMutation(async () => {
    const stashes = await getStashes();
    const item = stashes.find(item => item.id === stashId);
    if (item?.status === "scheduled") {
      closedStashes.delete(stashId);
      return { ok: true };
    }
    if (item?.status !== "stashing") closedStashes.delete(stashId);
    if (!item || !closedStashes.has(stashId)) {
      return { ok: false, error: "Stash completion cannot be confirmed. Check the saved entry before restoring or deleting it." };
    }
    return finishStash(stashes, item, closedStashes.get(stashId));
  });
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
    return { ok: true, restoredTab };
  } catch (error) {
    console.error("Failed to restore stash:", stashItem.url, error);
    return {
      ok: false,
      error,
    };
  }
}

async function finishRestore(stashes, stashItem, receipt) {
  try {
    // Persist the fact of creation before clearing its alarm or removing it.
    // A later context can finish cleanup without looking up a possibly reused ID.
    if (stashItem.status !== "restored") {
      await setStashes(stashes.map(item => item.id === stashItem.id ? {
        ...item, status: "restored", restoredTabId: receipt.restoredTabId,
        nextRetryAt: null,
      } : item));
    }
    await clearRestoreAlarm(stashItem.id);
    await setStashes(stashes.filter(item => item.id !== stashItem.id));
    completedRestores.delete(stashItem.id);
    return { ...receipt, cleanupPending: false };
  } catch (error) {
    console.warn("Tab restored; cleanup remains pending:", stashItem.id, error);
    return { ...receipt, cleanupPending: true };
  }
}

async function performRestoreStashById(stashId, { confirmRestore = false, automatic = false } = {}) {
  const stashes = await getStashes();
  const stashItem = stashes.find((item) => item.id === stashId);

  if (!stashItem) {
    completedRestores.delete(stashId);
    closedStashes.delete(stashId);
    console.warn("No stashed item found for ID:", stashId);
    return;
  }
  if (stashItem.status !== "stashing") closedStashes.delete(stashId);

  const receipt = completedRestores.get(stashId) ?? (stashItem.status === "restored" ? {
    ok: true, restoredTabId: stashItem.restoredTabId, notificationId: null,
  } : null);
  if (receipt) return finishRestore(stashes, stashItem, receipt);

  if (stashItem.status === "stashing") {
    if (closedStashes.has(stashId)) {
      const finished = await finishStash(stashes, stashItem, closedStashes.get(stashId));
      if (!finished.ok) return finished;
      return performRestoreStashById(stashId, { confirmRestore, automatic });
    }
    if (!confirmRestore || automatic) {
      return {
        ok: false, requiresConfirmation: true,
        error: "Stashing was interrupted. The source tab may still be open; check your tabs before restoring the saved copy.",
      };
    }
  }

  if (stashItem.status === "restoring" && (!confirmRestore || automatic)) {
    return {
      ok: false, requiresConfirmation: true,
      error: "A previous restore may have opened this tab. Check your tabs before choosing Restore again.",
    };
  }

  if (automatic) {
    const dueAt = getRestoreDueAt(stashItem);
    if (dueAt === null || dueAt > Date.now()) {
      return { ok: false, retryPending: dueAt !== null, retryExhausted: dueAt === null };
    }
  }

  try {
    await setStashes(stashes.map(item => item.id === stashId ? {
      ...item, status: "restoring", restoredTabId: null,
      nextRetryAt: null,
    } : item));
  } catch (error) {
    console.error("Could not save restore progress:", error);
    return { ok: false, error: "Could not save restore progress. No tab was opened." };
  }

  const creation = await restoreStashItem(stashItem);
  if (!creation.ok) {
    // Only a known creation failure earns a retry. Manual Restore (including
    // restore-all) starts a fresh cycle; automatic attempts consume its budget.
    const failures = (automatic ? getRestoreFailureCount(stashItem) : 0) + 1;
    const delay = RESTORE_RETRY_DELAYS[failures - 1];
    const failedItem = {
      ...stashItem, status: "scheduled", restoredTabId: null,
      restoreFailureCount: failures,
      nextRetryAt: delay === undefined ? null : Date.now() + delay,
    };
    try {
      await setStashes(stashes.map(item => item.id === stashId ? failedItem : item));
    } catch (error) {
      // Leave the durable intent intact; a future context must request review.
      console.warn("Could not reset failed restore progress:", error);
      return { ok: false, error: "Could not reopen this tab or save its retry schedule. Check the stash list before trying again." };
    }
    try {
      if (failedItem.nextRetryAt !== null) {
        await createRestoreAlarm(failedItem);
      } else {
        await clearRestoreAlarm(stashId);
      }
    } catch (error) {
      console.warn("Could not update the retry alarm:", error);
      return {
        ok: false, retryExhausted: failedItem.nextRetryAt === null,
        error: failedItem.nextRetryAt === null
          ? "Automatic retries have stopped. Choose Restore to try again."
          : "Could not reopen this tab or schedule its retry. Choose Restore to try again; saved retry timing will be checked when Backstash next starts.",
      };
    }
    return {
      ok: false, retryScheduled: failedItem.nextRetryAt !== null,
      retryExhausted: failedItem.nextRetryAt === null,
      error: failedItem.nextRetryAt !== null
        ? "Could not reopen this tab. An automatic retry is scheduled."
        : "Automatic retries have stopped. Choose Restore to try again.",
    };
  }

  const { restoredTab } = creation;
  const completed = { ok: true, restoredTabId: restoredTab.id, notificationId: null };
  completedRestores.set(stashId, completed);
  const result = await finishRestore(stashes, stashItem, completed);
  // Grouping and notification failures must never turn successful creation into
  // another attempt to create the tab. These are best-effort, once per creation.
  try {
    await restoreTabGroupMembership(stashItem, restoredTab);
    result.notificationId = await notifyStashRestored(stashItem);
  } catch (error) {
    console.warn("Tab restored; optional presentation failed:", error);
  }
  return result;
}

/**
 * Restore a stashed tab when its alarm fires.
 */
async function restoreStashById(stashId, options = {}) {
  const existingRestore = restoreOperations.get(stashId);
  if (existingRestore) {
    return existingRestore;
  }

  const restorePromise = enqueueMutation(() => performRestoreStashById(stashId, options)).finally(() => {
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
  let cleanupPendingCount = 0;

  for (const stashItem of stashes) {
    const result = await performRestoreStashById(stashItem.id);
    if (result.ok) {
      restoredCount += 1;
      if (result.cleanupPending) cleanupPendingCount += 1;
      continue;
    }

    failedCount += 1;
  }

  console.log(
    `Restore-all completed: ${restoredCount} restored, ${failedCount} failed, ${cleanupPendingCount} awaiting cleanup.`,
  );

  return {
    ok: restoredCount > 0,
    restoredCount,
    failedCount,
    cleanupPendingCount,
  };
}

async function reconcileScheduledStashes() {
  return enqueueMutation(performReconcileScheduledStashes);
}

async function performReconcileScheduledStashes() {
  const stashes = await getStashes();
  const alarms = await getRestoreAlarms();
  const stashIds = new Set(stashes.map((stashItem) => stashItem.id));
  const alarmsByName = new Map(alarms.map(alarm => [alarm.name, alarm]));

  let recreatedAlarmCount = 0;
  let clearedAlarmCount = 0;
  let dueRestoreCount = 0;

  for (const stashItem of stashes) {
    if (stashItem.status === "stashing") {
      if (closedStashes.has(stashItem.id)) {
        await performRestoreStashById(stashItem.id, { automatic: true });
      } else {
        await clearPendingStashAlarm(stashItem.id);
      }
      continue;
    }
    if (stashItem.status === "restored" || completedRestores.has(stashItem.id)) {
      await performRestoreStashById(stashItem.id);
      continue;
    }
    if (stashItem.status === "restoring") {
      // Never re-arm uncertain attempts, including ones whose original due time
      // is still in the future. Manual review is required before creating again.
      try {
        await clearRestoreAlarm(stashItem.id);
      } catch (error) {
        console.warn("Could not clear an uncertain restore alarm:", error);
      }
      continue;
    }
    const dueAt = getRestoreDueAt(stashItem);
    if (dueAt === null) {
      try {
        await clearRestoreAlarm(stashItem.id);
      } catch (error) {
        console.warn("Could not clear an exhausted retry alarm:", error);
      }
      continue;
    }
    if (dueAt <= Date.now()) {
      dueRestoreCount += 1;
      await performRestoreStashById(stashItem.id, { automatic: true });
      continue;
    }

    const alarmName = makeAlarmName(stashItem.id);
    const alarm = alarmsByName.get(alarmName);
    if (!alarm || (getRestoreFailureCount(stashItem) > 0 && alarm.scheduledTime !== dueAt)) {
      try {
        await createRestoreAlarm(stashItem);
        recreatedAlarmCount += 1;
      } catch (error) {
        console.warn("Could not recreate a restore alarm:", error);
      }
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
    .sort((left, right) => (getRestoreDueAt(left) ?? left.wakeAt) - (getRestoreDueAt(right) ?? right.wakeAt))
    .map((stashItem) => ({
      id: stashItem.id,
      title: stashItem.title,
      url: stashItem.url,
      wakeAt: stashItem.wakeAt,
      status: completedRestores.has(stashItem.id) ? "restored"
        : stashItem.status === "stashing" && closedStashes.has(stashItem.id) ? "stashed" : (stashItem.status ?? "scheduled"),
      nextRetryAt: getRestoreFailureCount(stashItem) > 0 ? getRestoreDueAt(stashItem) : null,
      retryExhausted: getRestoreFailureCount(stashItem) > 0 && getRestoreDueAt(stashItem) === null,
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
  completedRestores.delete(stashId);
  closedStashes.delete(stashId);
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
    return restoreStashById(message.stashId, { confirmRestore: message.confirmRestore === true });
  }

  if (message?.type === "finish-stash") {
    return finishStashById(message.stashId);
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
    await restoreStashById(stashID, { automatic: true });
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
