const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function storageHarness(initialStorage) {
  let stored = structuredClone(initialStorage);
  const context = vm.createContext({
    browser: {
      storage: {
        local: {
          get: async () => structuredClone(stored),
          set: async value => { stored = structuredClone(value); },
        },
      },
    },
  });
  for (const file of ["constants.js", "storage.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
  }
  return {
    settings: () => vm.runInContext("getSettings()", context),
    saveStashes: () => vm.runInContext("setStashes([])", context),
    read: () => structuredClone(stored),
  };
}

for (const [name, initialStorage] of [
  ["an empty storage root", {}],
  ["a stored root without settings", { backstash: { stashes: [] } }],
  ["settings without presets", { backstash: { settings: { showNotifications: false } } }],
]) {
  test(`mutating default presets from ${name} cannot affect later reads or writes`, async () => {
    const h = storageHarness(initialStorage);
    const first = await h.settings();
    first.stashPresetMinutes[0] = 99;
    first.stashPresetMinutes.push(30);

    assert.deepEqual(Array.from((await h.settings()).stashPresetMinutes), [1, 60, 1440]);
    assert.deepEqual(h.read(), initialStorage, "reading settings must not persist mutations");

    // An unrelated write must not persist a caller's changes to defaults either.
    await h.saveStashes();
    assert.deepEqual(h.read().backstash.settings.stashPresetMinutes, [1, 60, 1440]);
  });
}

test("settings reads preserve configured presets and isolate caller mutations", async () => {
  const initialStorage = { backstash: { settings: { stashPresetMinutes: [5, 25], showNotifications: false } } };
  const h = storageHarness(initialStorage);
  const first = await h.settings();
  assert.deepEqual(Array.from(first.stashPresetMinutes), [5, 25]);
  assert.equal(first.showNotifications, false);
  first.stashPresetMinutes.push(99);
  assert.deepEqual(Array.from((await h.settings()).stashPresetMinutes), [5, 25]);
  assert.deepEqual(h.read(), initialStorage);
});
