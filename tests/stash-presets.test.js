const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_STASH_PRESET_MINUTES,
  isValidDurationMinutes,
  normalizeStashPresetMinutes,
  getDefaultStashPresetMinutes,
  getCommandStashPresetMinutes,
  getRepeatLastStashMinutes,
} = require("../stash-presets.js");

test("isValidDurationMinutes accepts positive whole minutes", () => {
  assert.equal(isValidDurationMinutes(1), true);
  assert.equal(isValidDurationMinutes(1440), true);
});

test("isValidDurationMinutes rejects invalid minute values", () => {
  assert.equal(isValidDurationMinutes(0), false);
  assert.equal(isValidDurationMinutes(-5), false);
  assert.equal(isValidDurationMinutes(30.5), false);
  assert.equal(isValidDurationMinutes("60"), false);
});

test("normalizeStashPresetMinutes falls back to defaults", () => {
  assert.deepEqual(
    normalizeStashPresetMinutes(undefined),
    DEFAULT_STASH_PRESET_MINUTES,
  );
});

test("normalizeStashPresetMinutes keeps valid unique positive minutes", () => {
  assert.deepEqual(
    normalizeStashPresetMinutes([1, 60, 60, -5, 1440, 0, 30.5]),
    [1, 60, 1440],
  );
});

test("getDefaultStashPresetMinutes uses the configured default when valid", () => {
  assert.equal(
    getDefaultStashPresetMinutes({
      stashPresetMinutes: [1, 60, 1440],
      defaultStashPresetMinutes: 60,
    }),
    60,
  );
});

test("getDefaultStashPresetMinutes falls back to the first preset", () => {
  assert.equal(
    getDefaultStashPresetMinutes({
      stashPresetMinutes: [1, 60, 1440],
      defaultStashPresetMinutes: 5,
    }),
    1,
  );
});

test("getCommandStashPresetMinutes resolves known commands", () => {
  const settings = {
    stashPresetMinutes: [1, 60, 1440],
  };

  assert.equal(getCommandStashPresetMinutes("duration-1", settings), 1);
  assert.equal(getCommandStashPresetMinutes("duration-2", settings), 60);
  assert.equal(getCommandStashPresetMinutes("duration-3", settings), 1440);
});

test("getCommandStashPresetMinutes ignores unknown commands", () => {
  assert.equal(getCommandStashPresetMinutes("stash-5m"), null);
});

test("getCommandStashPresetMinutes uses the configured preset list", () => {
  assert.equal(
    getCommandStashPresetMinutes("duration-2", {
      stashPresetMinutes: [5, 15, 30],
    }),
    15,
  );
});

test("getRepeatLastStashMinutes returns the previous minute preset", () => {
  assert.equal(
    getRepeatLastStashMinutes({
      lastStashPresetMinutes: 60,
    }),
    60,
  );
});

test("getRepeatLastStashMinutes ignores unsupported or missing state", () => {
  assert.equal(getRepeatLastStashMinutes({}), null);
  assert.equal(
    getRepeatLastStashMinutes({
      lastStashPresetMinutes: 0,
    }),
    null,
  );
  assert.equal(
    getRepeatLastStashMinutes({
      lastStashPresetMinutes: -5,
    }),
    null,
  );
  assert.equal(
    getRepeatLastStashMinutes({
      lastStashPresetMinutes: 30.5,
    }),
    null,
  );
});
