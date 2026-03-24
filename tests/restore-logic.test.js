const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildStashRestoreContext,
  chooseRestoreWindowId,
  chooseRestoreTabIndex,
} = require("../restore-logic.js");

test("buildStashRestoreContext stores window and tab position", () => {
  assert.deepEqual(
    buildStashRestoreContext({
      windowId: 42,
      index: 3,
    }),
    {
      originalWindowId: 42,
      originalTabIndex: 3,
    },
  );
});

test("buildStashRestoreContext normalizes missing tab position", () => {
  assert.deepEqual(
    buildStashRestoreContext({
      windowId: 42,
      index: undefined,
    }),
    {
      originalWindowId: 42,
      originalTabIndex: null,
    },
  );
});

test("chooseRestoreWindowId prefers the original window when it still exists", () => {
  assert.equal(
    chooseRestoreWindowId({
      originalWindowId: 7,
      existingWindowIds: [1, 7, 9],
      lastFocusedWindowId: 9,
    }),
    7,
  );
});

test("chooseRestoreWindowId falls back to the last focused window", () => {
  assert.equal(
    chooseRestoreWindowId({
      originalWindowId: 7,
      existingWindowIds: [1, 9],
      lastFocusedWindowId: 9,
    }),
    9,
  );
});

test("chooseRestoreWindowId returns null when no valid target exists", () => {
  assert.equal(
    chooseRestoreWindowId({
      originalWindowId: 7,
      existingWindowIds: [],
      lastFocusedWindowId: null,
    }),
    null,
  );
});

test("chooseRestoreTabIndex preserves the original index when it fits", () => {
  assert.equal(
    chooseRestoreTabIndex({
      originalTabIndex: 2,
      tabCount: 5,
    }),
    2,
  );
});

test("chooseRestoreTabIndex clamps to the end of the target window", () => {
  assert.equal(
    chooseRestoreTabIndex({
      originalTabIndex: 5,
      tabCount: 2,
    }),
    2,
  );
});

test("chooseRestoreTabIndex returns null for invalid metadata", () => {
  assert.equal(
    chooseRestoreTabIndex({
      originalTabIndex: null,
      tabCount: 2,
    }),
    null,
  );
});
