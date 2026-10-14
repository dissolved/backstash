const test = require("node:test");
const assert = require("node:assert/strict");

function createBackgroundHarness() {
  const listeners = {
    onCommand: null,
    onMessage: null,
    onStartup: null,
    onAlarm: null,
  };
  const stats = {
    tabsCreateCalls: 0,
    setStashesCalls: 0,
    clearedAlarmNames: [],
  };

  let currentStashes = [];
  let releaseRestore;
  const restoreCreated = new Promise((resolve) => {
    releaseRestore = resolve;
  });

  global.BackstashPresets = {
    isValidDurationMinutes(minutes) {
      return Number.isInteger(minutes) && minutes > 0;
    },
    getRepeatLastStashMinutes() {
      return null;
    },
    getCommandStashPresetMinutes() {
      return null;
    },
  };
  global.buildStashRestoreContext = () => ({
    originalWindowId: null,
    originalTabIndex: null,
  });
  global.chooseRestoreWindowId = ({ lastFocusedWindowId }) => lastFocusedWindowId;
  global.chooseRestoreTabIndex = () => null;
  global.getStashes = async () => currentStashes;
  global.setStashes = async (stashes) => {
    stats.setStashesCalls += 1;
    currentStashes = stashes;
  };
  global.getSettings = async () => ({
    restoreInBackground: true,
    showNotifications: false,
  });
  global.getState = async () => ({});
  global.updateState = async () => {};

  global.browser = {
    alarms: {
      create: async () => {},
      clear: async (name) => {
        stats.clearedAlarmNames.push(name);
      },
      getAll: async () => [],
    },
    windows: {
      get: async () => ({ id: 1 }),
      getLastFocused: async () => ({ id: 1 }),
    },
    tabs: {
      query: async () => [],
      remove: async () => {},
      create: async () => {
        stats.tabsCreateCalls += 1;
        await restoreCreated;
        return { id: 42, windowId: 1, cookieStoreId: null };
      },
      group: async () => {},
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async () => ({ windowId: 1 }),
    },
    notifications: {
      create: async () => "notification-id",
    },
    commands: {
      onCommand: {
        addListener(listener) {
          listeners.onCommand = listener;
        },
      },
    },
    runtime: {
      onMessage: {
        addListener(listener) {
          listeners.onMessage = listener;
        },
      },
      onStartup: {
        addListener(listener) {
          listeners.onStartup = listener;
        },
      },
    },
    action: {
      openPopup: async () => {},
    },
  };
  global.browser.alarms.onAlarm = {
    addListener(listener) {
      listeners.onAlarm = listener;
    },
  };

  delete require.cache[require.resolve("../background.js")];
  const background = require("../background.js");

  return {
    background,
    stats,
    listeners,
    setCurrentStashes(stashes) {
      currentStashes = stashes;
    },
    getCurrentStashes() {
      return currentStashes;
    },
    releaseRestore() {
      releaseRestore();
    },
    cleanup() {
      delete require.cache[require.resolve("../background.js")];
      delete global.BackstashPresets;
      delete global.buildStashRestoreContext;
      delete global.chooseRestoreWindowId;
      delete global.chooseRestoreTabIndex;
      delete global.getStashes;
      delete global.setStashes;
      delete global.getSettings;
      delete global.getState;
      delete global.updateState;
      delete global.browser;
    },
  };
}

test("restoreStashById collapses concurrent restores for the same stash", async () => {
  const harness = createBackgroundHarness();
  // Startup reconciliation is queued too; seed only after it has completed.
  await new Promise(resolve => setImmediate(resolve));
  const stashItem = {
    id: "stash-1",
    url: "https://example.com",
    title: "Example",
    wakeAt: Date.now() - 1000,
    originalWindowId: null,
    originalTabIndex: null,
    originalGroupId: null,
    cookieStoreId: null,
  };

  harness.setCurrentStashes([stashItem]);

  try {
    const firstRestore = harness.background.restoreStashById(stashItem.id);
    const secondRestore = harness.background.restoreStashById(stashItem.id);

    harness.releaseRestore();

    const [firstResult, secondResult] = await Promise.all([
      firstRestore,
      secondRestore,
    ]);

    assert.equal(harness.stats.tabsCreateCalls, 1);
    assert.deepEqual(harness.getCurrentStashes(), []);
    assert.deepEqual(harness.stats.clearedAlarmNames, [
      harness.background.makeAlarmName(stashItem.id),
    ]);
    assert.equal(firstResult.ok, true);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(harness.background.__testing.restoreOperations.size, 0);
  } finally {
    harness.cleanup();
  }
});
