const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function harness() {
  const listeners = {};
  const alarms = new Map();
  let stored = {};
  const created = [];
  const removed = [];
  const notifications = [];
  let activeTabId = 7;
  const fixtureTab = id => ({ id, windowId: 1, index: 2, url: 'https://example.com', title: 'Fixture' });
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const browser = {
    storage: { local: {
      get: async () => structuredClone(stored),
      set: async value => { stored = structuredClone(value); },
    } },
    alarms: {
      create: async (name, alarm) => { alarms.set(name, { name, ...alarm }); },
      clear: async name => alarms.delete(name),
      getAll: async () => [...alarms.values()], onAlarm: event('alarm'),
    },
    windows: { get: async id => ({ id }), getLastFocused: async () => ({ id: 1 }) },
    tabs: {
      query: async () => [fixtureTab(activeTabId)],
      get: async id => {
        if (removed.includes(id)) throw new Error('tab closed');
        return fixtureTab(id);
      },
      remove: async id => { removed.push(id); if (activeTabId === id) activeTabId += 1; },
      create: async options => { created.push(options); return { id: 42, windowId: 1 }; },
    },
    notifications: { create: async (id, options) => { notifications.push(options); return id; } },
    commands: { onCommand: event('command') },
    runtime: { onMessage: event('message'), onStartup: event('startup') },
    action: { openPopup: async () => {} },
  };
  const context = vm.createContext({ browser, console: { log() {}, warn() {}, error() {} } });
  for (const file of ['constants.js', 'storage.js', 'restore-logic.js', 'stash-presets.js', 'background.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  // Let the automatic initial reconciliation finish before seeding scenarios.
  await new Promise(resolve => setImmediate(resolve));
  return {
    browser, alarms, created, removed, notifications, listeners,
    send: (type, fields = {}) => listeners.message({ type, ...fields }),
    read: () => stored.backstash,
    selectTab(id) { activeTabId = id; },
    seed(stashes, settings = {}) { stored = { backstash: { schemaVersion: 1, stashes, settings, state: {} } }; },
    reconcile: () => vm.runInContext('reconcileScheduledStashes()', context),
  };
}

const item = (id, wakeAt = Date.now() + 600000) => ({
  id, wakeAt, url: `https://example.com/${id}`, title: id,
  originalWindowId: 1, originalTabIndex: 2, cookieStoreId: null,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Stop one real production restore at tab creation so competing requests are
// guaranteed to overlap; no timer-based race assumptions.
function pauseRestore(h) {
  const entered = deferred();
  const release = deferred();
  const create = h.browser.tabs.create;
  let paused = false;
  h.browser.tabs.create = async options => {
    if (!paused) {
      paused = true;
      entered.resolve();
      await release.promise;
    }
    return create(options);
  };
  return { entered: entered.promise, release: release.resolve };
}

test('overlapping individual restores do not resurrect either stash', async () => {
  const h = await harness();
  h.seed([item('first'), item('second')]);
  const paused = pauseRestore(h);
  const first = h.send('restore-stash-now', { stashId: 'first' });
  await paused.entered;
  const second = h.send('restore-stash-now', { stashId: 'second' });
  paused.release();
  const results = await Promise.all([first, second]);
  assert(results.every(result => result.ok));
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.created.length, 2);
});

for (const firstAction of ['restore-all-stashes', 'restore-stash-now']) {
  test(`overlapping bulk and individual restores create each tab once (${firstAction} first)`, async () => {
    const h = await harness();
    h.seed([item('first'), item('second')]);
    const paused = pauseRestore(h);
    const first = h.send(firstAction, { stashId: 'first' });
    await paused.entered;
    const secondAction = firstAction === 'restore-all-stashes' ? 'restore-stash-now' : 'restore-all-stashes';
    const second = h.send(secondAction, { stashId: 'first' });
    const third = h.send('restore-all-stashes');
    paused.release();
    await Promise.all([first, second, third]);
    assert.deepEqual(h.created.map(tab => tab.url).sort(), [item('first').url, item('second').url]);
    assert.equal(h.read().stashes.length, 0);
    assert.equal(h.alarms.size, 0);
  });
}

test('cancellation before a restore prevents reopening, including restore-all', async () => {
  const h = await harness();
  h.seed([item('cancelled'), item('kept')]);
  const cancel = h.send('cancel-stash', { stashId: 'cancelled' });
  const restore = h.send('restore-stash-now', { stashId: 'cancelled' });
  const all = h.send('restore-all-stashes');
  assert((await cancel).ok);
  await Promise.all([restore, all]);
  assert.deepEqual(h.created.map(tab => tab.url), [item('kept').url]);
  assert.equal(h.read().stashes.length, 0);
});

test('cancellation during a restore cannot resurrect another stash', async () => {
  const h = await harness();
  h.seed([item('restoring'), item('cancelled')]);
  const paused = pauseRestore(h);
  const restore = h.send('restore-stash-now', { stashId: 'restoring' });
  await paused.entered;
  const same = h.send('cancel-stash', { stashId: 'restoring' });
  const other = h.send('cancel-stash', { stashId: 'cancelled' });
  paused.release();
  assert((await restore).ok);
  assert(!(await same).ok, 'restore already completed before cancellation');
  assert((await other).ok);
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 0);
});

for (const restoreAction of ['restore-stash-now', 'restore-all-stashes']) {
  test(`new stashes and repeat-last state survive overlapping ${restoreAction}`, async () => {
    const h = await harness();
    h.seed([item('old')]);
    const paused = pauseRestore(h);
    const restore = h.send(restoreAction, { stashId: 'old' });
    await paused.entered;
    const stash = h.send('stash-for-minutes', { minutes: 15 });
    h.selectTab(8);
    const repeat = h.listeners.command('repeat-last-stash');
    h.selectTab(9);
    paused.release();
    await Promise.all([restore, stash, repeat]);
    assert.equal(h.created.length, 1);
    assert.equal(h.read().stashes.length, 2);
    assert(h.read().stashes.every(stash => stash.id !== 'old'));
    assert.equal(h.read().state.lastStashPresetMinutes, 15);
    assert.equal(h.removed.length, 2);
    assert.deepEqual(h.removed, [7, 8], 'queued actions must keep their original target tabs');
    assert.equal(h.alarms.size, 2);
  });
}

test('overlapping stash requests for the same source tab persist and close it only once', async () => {
  const h = await harness();
  h.seed([item('old')]);
  const paused = pauseRestore(h);
  const restore = h.send('restore-stash-now', { stashId: 'old' });
  await paused.entered;
  const first = h.send('stash-for-minutes', { minutes: 15 });
  const second = h.send('stash-for-minutes', { minutes: 30 });
  paused.release();
  await restore;
  assert((await first).ok);
  assert(!(await second).ok);
  assert.deepEqual(h.removed, [7]);
  assert.equal(h.read().stashes.length, 1);
  assert.equal(h.read().state.lastStashPresetMinutes, 15);
  assert.equal(h.alarms.size, 1);
});

test('a queued stash refuses a source tab closed while waiting', async () => {
  const h = await harness();
  h.seed([item('old')]);
  const paused = pauseRestore(h);
  const restore = h.send('restore-stash-now', { stashId: 'old' });
  await paused.entered;
  const stash = h.send('stash-for-minutes', { minutes: 15 });
  await h.browser.tabs.remove(7);
  paused.release();
  await restore;
  assert(!(await stash).ok);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.removed, [7]);
});

test('reconciliation overlapping restore, cancel and stash leaves only live alarms', async () => {
  const h = await harness();
  h.seed([item('due', 0), item('cancelled')]);
  const paused = pauseRestore(h);
  const reconciliation = h.reconcile();
  await paused.entered;
  const cancel = h.send('cancel-stash', { stashId: 'cancelled' });
  const restore = h.send('restore-stash-now', { stashId: 'due' });
  const stash = h.send('stash-for-minutes', { minutes: 10 });
  paused.release();
  await Promise.all([reconciliation, cancel, restore, stash]);
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 1);
  assert.deepEqual([...h.alarms.keys()], [`restore-stash:${h.read().stashes[0].id}`]);
});

test('a rejected storage write does not block later queued operations', async () => {
  const h = await harness();
  h.seed([item('cancelled')]);
  const set = h.browser.storage.local.set;
  let fail = true;
  h.browser.storage.local.set = async value => {
    if (fail) { fail = false; throw new Error('disk full'); }
    return set(value);
  };
  const stash = h.send('stash-for-minutes', { minutes: 10 });
  const cancel = h.send('cancel-stash', { stashId: 'cancelled' });
  await assert.rejects(stash, /disk full/);
  assert((await cancel).ok);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.removed.length, 0);
});

test('reconciliation recreates missing alarms, preserves existing alarms, clears only owned orphans and restores overdue stashes', async () => {
  const h = await harness();
  h.seed([item('missing'), item('existing'), item('due', 0)]);
  h.alarms.set('restore-stash:existing', { name: 'restore-stash:existing', when: 123 });
  h.alarms.set('restore-stash:orphan', { name: 'restore-stash:orphan' });
  h.alarms.set('other-extension-task', { name: 'other-extension-task' });
  await h.reconcile();
  assert(h.alarms.has('restore-stash:missing'));
  assert.equal(h.alarms.get('restore-stash:existing').when, 123);
  assert(!h.alarms.has('restore-stash:orphan'));
  assert(h.alarms.has('other-extension-task'));
  assert.deepEqual(h.read().stashes.map(i => i.id), ['missing', 'existing']);
  assert.equal(h.created.length, 1);
  await h.reconcile();
  assert.equal(h.created.length, 1, 'repeat reconciliation must not duplicate overdue restore');
});

test('failed restore retains stash and succeeds on a later reconciliation', async () => {
  const h = await harness();
  h.seed([item('due', 0)]);
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async () => { throw new Error('window unavailable'); };
  await h.reconcile();
  assert.equal(h.read().stashes.length, 1);
  h.browser.tabs.create = create;
  await h.reconcile();
  assert.equal(h.read().stashes.length, 0);
});

test('stash persists before closing, remembers duration, and cancel removes stash and alarm without reopening', async () => {
  const h = await harness();
  h.browser.tabs.remove = async id => {
    assert.equal(h.read().stashes.length, 1);
    assert(h.alarms.has(`restore-stash:${h.read().stashes[0].id}`));
    h.removed.push(id);
  };
  assert((await h.send('stash-for-minutes', { minutes: 15 })).ok);
  assert.equal(h.read().state.lastStashPresetMinutes, 15);
  const stash = h.read().stashes[0];
  assert.equal(stash.originalTabIndex, 2);
  assert((await h.send('cancel-stash', { stashId: stash.id })).ok);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.alarms.size, 0);
  assert.equal(h.created.length, 0);
  assert(!(await h.send('cancel-stash', { stashId: stash.id })).ok);
});

test('failed persistence prevents closing the source tab or scheduling an alarm', async () => {
  const h = await harness();
  h.browser.storage.local.set = async () => { throw new Error('disk full'); };
  await assert.rejects(h.send('stash-for-minutes', { minutes: 10 }), /disk full/);
  assert.equal(h.removed.length, 0);
  assert.equal(h.alarms.size, 0);
});

test('restore-all retains failed stashes and clears successful alarms', async () => {
  const h = await harness();
  h.seed([item('good'), item('bad')]);
  for (const id of ['good', 'bad']) h.alarms.set(`restore-stash:${id}`, { name: `restore-stash:${id}` });
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async options => {
    if (options.url.endsWith('/bad')) throw new Error('creation failed');
    return create(options);
  };
  const result = await h.send('restore-all-stashes');
  assert.equal(result.restoredCount, 1);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(h.read().stashes.map(i => i.id), ['bad']);
  assert(!h.alarms.has('restore-stash:good'));
  assert(h.alarms.has('restore-stash:bad'));
});

test('notification failure does not undo a successful restore; settings control notifications and foreground restore', async () => {
  const h = await harness();
  h.seed([item('first')], { showNotifications: true, restoreInBackground: false });
  h.browser.notifications.create = async () => { throw new Error('OS notifications unavailable'); };
  assert((await h.send('restore-stash-now', { stashId: 'first' })).ok);
  assert.equal(h.created[0].active, true);
  assert.equal(h.read().stashes.length, 0);
  h.seed([item('second')], { showNotifications: false });
  h.browser.notifications.create = async () => { assert.fail('disabled notification called'); };
  assert((await h.send('restore-stash-now', { stashId: 'second' })).ok);
  assert.equal(h.created[1].active, false);
});

test('keyboard commands use configured presets, repeat last duration, open popup and restore all', async () => {
  const h = await harness();
  h.seed([], { stashPresetMinutes: [5, 30, 120] });
  let opened = 0;
  h.browser.action.openPopup = async () => { opened += 1; };
  await h.listeners.command('open-stash-overlay');
  assert.equal(opened, 1);
  await h.listeners.command('duration-2');
  assert.equal(h.read().state.lastStashPresetMinutes, 30);
  assert.equal(h.read().stashes.length, 1);
  await h.listeners.command('repeat-last-stash');
  assert.equal(h.read().stashes.length, 2);
  await h.listeners.command('unknown');
  assert.equal(h.read().stashes.length, 2);
  await h.listeners.command('restore-all-stashes');
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.created.length, 2);
});
