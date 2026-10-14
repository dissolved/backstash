const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

async function harness() {
  let now = Date.now();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
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
      create: async (name, alarm) => { alarms.set(name, { name, ...alarm, scheduledTime: alarm.when }); },
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
  let context;
  async function loadBackground() {
    context = vm.createContext({ browser, Date: Clock, console: { log() {}, warn() {}, error() {} } });
    for (const file of ['constants.js', 'storage.js', 'restore-logic.js', 'stash-presets.js', 'background.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    // Finish automatic reconciliation, retaining storage but replacing memory.
    await new Promise(resolve => setImmediate(resolve));
  }
  await loadBackground();
  return {
    browser, alarms, created, removed, notifications, listeners,
    send: (type, fields = {}) => listeners.message({ type, ...fields }),
    read: () => stored.backstash,
    selectTab(id) { activeTabId = id; },
    seed(stashes, settings = {}) { stored = { backstash: { schemaVersion: 1, stashes, settings, state: {} } }; },
    reconcile: () => vm.runInContext('reconcileScheduledStashes()', context),
    reload: loadBackground,
    now: () => now,
    advance(milliseconds) { now += milliseconds; },
    fireAlarm(id) {
      const name = `restore-stash:${id}`;
      alarms.delete(name);
      return listeners.alarm({ name });
    },
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

test('known failures retry after 1, 5 and 15 minutes, then stop across alarms and reloads', async () => {
  const h = await harness();
  h.seed([item('retry', 0)]);
  let attempts = 0;
  h.browser.tabs.create = async () => { attempts += 1; throw new Error('creation unavailable'); };
  await h.reconcile();
  assert.equal(attempts, 1);
  for (const [index, delay] of [60_000, 300_000, 900_000].entries()) {
    const failed = h.read().stashes[0];
    assert.equal(failed.restoreFailureCount, index + 1);
    assert.equal(failed.nextRetryAt, h.now() + delay);
    assert.equal(h.alarms.get('restore-stash:retry').scheduledTime, failed.nextRetryAt);
    await h.reload();
    assert.equal(attempts, index + 1, 'reload must not bypass the retry delay');
    h.advance(delay - 1);
    await h.reconcile();
    assert.equal(attempts, index + 1);
    h.advance(1);
    await h.fireAlarm('retry');
    assert.equal(attempts, index + 2);
  }
  assert.equal(h.read().stashes[0].restoreFailureCount, 4);
  assert.equal(h.read().stashes[0].nextRetryAt, null);
  assert.equal(h.alarms.size, 0);
  assert((await h.send('list-stashes'))[0].retryExhausted);
  h.advance(86400_000);
  await h.reload();
  await h.reconcile();
  await h.fireAlarm('retry');
  assert.equal(attempts, 4, 'exhausted attempts must not restart automatically');
});

test('a manual restore can run before a retry is due and starts a new retry cycle', async () => {
  const h = await harness();
  h.seed([{ ...item('retry', 0), restoreFailureCount: 3, nextRetryAt: h.now() + 900_000 }]);
  h.browser.tabs.create = async () => { throw new Error('creation failed'); };
  const result = await h.send('restore-stash-now', { stashId: 'retry' });
  assert(result.retryScheduled);
  assert.equal(h.read().stashes[0].restoreFailureCount, 1);
  assert.equal(h.read().stashes[0].nextRetryAt, h.now() + 60_000);
});

test('manual restore-all restarts exhausted budgets while skipping uncertain attempts', async () => {
  const h = await harness();
  h.seed([
    { ...item('retry', 0), restoreFailureCount: 4, nextRetryAt: null },
    { ...item('uncertain', 0), status: 'restoring' },
  ]);
  let attempts = 0;
  h.browser.tabs.create = async () => { attempts += 1; throw new Error('creation failed'); };
  await h.send('restore-all-stashes');
  assert.equal(attempts, 1);
  assert.equal(h.read().stashes[0].restoreFailureCount, 1);
  assert.equal(h.read().stashes[1].status, 'restoring');
  assert.equal(h.alarms.size, 1);
});

test('an overdue retry is attempted once after reload, then persists its next delay', async () => {
  const h = await harness();
  h.seed([{ ...item('retry', 0), restoreFailureCount: 1, nextRetryAt: h.now() - 1 }]);
  let attempts = 0;
  h.browser.tabs.create = async () => { attempts += 1; throw new Error('creation failed'); };
  await h.reload();
  assert.equal(attempts, 1);
  assert.equal(h.read().stashes[0].restoreFailureCount, 2);
  assert.equal(h.read().stashes[0].nextRetryAt, h.now() + 300_000);
  await h.reload();
  assert.equal(attempts, 1);
});

test('a successful retry removes its record and alarm without opening twice', async () => {
  const h = await harness();
  h.seed([{ ...item('retry', 0), restoreFailureCount: 1, nextRetryAt: h.now() + 60_000 }]);
  await h.reconcile();
  h.advance(60_000);
  await h.fireAlarm('retry');
  await h.reconcile();
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.alarms.size, 0);
});

test('missing and stale retry alarms are repaired without using the original overdue time', async () => {
  const h = await harness();
  const nextRetryAt = h.now() + 300_000;
  h.seed([{ ...item('retry', 0), restoreFailureCount: 2, nextRetryAt }]);
  await h.reconcile();
  assert.equal(h.created.length, 0);
  assert.equal(h.alarms.get('restore-stash:retry').scheduledTime, nextRetryAt);
  h.alarms.set('restore-stash:retry', { name: 'restore-stash:retry', scheduledTime: 123 });
  await h.reconcile();
  assert.equal(h.alarms.get('restore-stash:retry').scheduledTime, nextRetryAt);
  await h.listeners.alarm({ name: 'restore-stash:retry' });
  assert.equal(h.created.length, 0);
  assert.equal(h.read().stashes[0].restoreFailureCount, 2, 'stale early events must not consume the budget');
});

test('cancellation of a pending retry prevents late alarms and reload from reopening it', async () => {
  const h = await harness();
  h.seed([{ ...item('retry', 0), restoreFailureCount: 1, nextRetryAt: h.now() + 60_000 }]);
  await h.reconcile();
  assert((await h.send('cancel-stash', { stashId: 'retry' })).ok);
  h.advance(60_000);
  await h.fireAlarm('retry');
  await h.reload();
  assert.equal(h.created.length, 0);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.alarms.size, 0);
});

test('a saved retry whose alarm cannot be created is recovered on reload', async () => {
  const h = await harness();
  h.seed([item('retry', 0)]);
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async () => { throw new Error('creation failed'); };
  const alarm = h.browser.alarms.create;
  h.browser.alarms.create = async () => { throw new Error('alarm service unavailable'); };
  const result = await h.send('restore-stash-now', { stashId: 'retry' });
  assert(!result.ok && !result.retryScheduled);
  assert.equal(h.read().stashes[0].nextRetryAt, h.now() + 60_000);
  h.browser.alarms.create = alarm;
  h.browser.tabs.create = create;
  await h.reload();
  assert.equal(h.created.length, 0);
  assert.equal(h.alarms.get('restore-stash:retry').scheduledTime, h.now() + 60_000);
});

test('failure to persist retry metadata keeps the attempt uncertain without arming a retry', async () => {
  const h = await harness();
  h.seed([item('retry', 0)]);
  h.browser.tabs.create = async () => { throw new Error('creation failed'); };
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async value => {
    if (value.backstash.stashes.some(stash => stash.restoreFailureCount > 0)) throw new Error('retry write failed');
    return set(value);
  };
  await h.reconcile();
  assert.equal(h.read().stashes[0].status, 'restoring');
  assert.equal(h.alarms.size, 0);
  h.browser.storage.local.set = set;
  await h.reload();
  assert.equal(h.alarms.size, 0);
  assert((await h.send('restore-stash-now', { stashId: 'retry' })).requiresConfirmation);
});

test('retry alarms cannot create again for confirmed or uncertain recovery records', async () => {
  const h = await harness();
  h.seed([
    { ...item('completed', 0), status: 'restored', restoredTabId: 42, restoreFailureCount: 1, nextRetryAt: h.now() - 1 },
    { ...item('uncertain', 0), status: 'restoring', restoreFailureCount: 1, nextRetryAt: h.now() - 1 },
  ]);
  await h.fireAlarm('completed');
  await h.fireAlarm('uncertain');
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.read().stashes.map(stash => stash.id), ['uncertain']);
});

test('failure to clear an exhausted alarm cannot restart the automatic retry budget', async () => {
  const h = await harness();
  h.seed([{ ...item('retry', 0), restoreFailureCount: 3, nextRetryAt: h.now() - 1 }]);
  let attempts = 0;
  h.browser.tabs.create = async () => { attempts += 1; throw new Error('creation failed'); };
  h.browser.alarms.clear = async () => { throw new Error('clear failed'); };
  await h.fireAlarm('retry');
  await h.reconcile();
  await h.fireAlarm('retry');
  assert.equal(attempts, 1);
  assert.equal(h.read().stashes[0].restoreFailureCount, 4);
});

test('the stash list orders pending retries by their next due time', async () => {
  const h = await harness();
  h.seed([
    { ...item('retry', 0), restoreFailureCount: 1, nextRetryAt: h.now() + 300_000 },
    item('ordinary', h.now() + 60_000),
  ]);
  const list = await h.send('list-stashes');
  assert.deepEqual(Array.from(list, stash => stash.id), ['ordinary', 'retry']);
  assert.equal(list[1].nextRetryAt, h.now() + 300_000);
});

test('restore progress must persist before Firefox is asked to create a tab', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async () => { throw new Error('disk full'); };
  assert(!(await h.send('restore-stash-now', { stashId: 'saved' })).ok);
  assert.equal(h.created.length, 0);
  assert.equal(h.read().stashes.length, 1);
  h.browser.storage.local.set = set;
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async options => {
    assert.equal(h.read().stashes[0].status, 'restoring');
    return create(options);
  };
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).ok);
});

test('an alarm cleanup failure never turns a successful creation into another restore', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  h.alarms.set('restore-stash:saved', { name: 'restore-stash:saved' });
  const clear = h.browser.alarms.clear;
  h.browser.alarms.clear = async () => { throw new Error('alarm service unavailable'); };
  const result = await h.send('restore-stash-now', { stashId: 'saved' });
  assert(result.ok && result.cleanupPending);
  assert.equal(h.read().stashes[0].status, 'restored');
  assert.equal(h.created.length, 1);
  await h.send('restore-stash-now', { stashId: 'saved' });
  await h.send('restore-all-stashes');
  await h.reconcile();
  assert.equal(h.created.length, 1);
  assert.equal(h.notifications.length, 1, 'cleanup must not repeat notifications');
  h.browser.alarms.clear = clear;
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).ok);
  assert.equal(h.read().stashes.length, 0);
  assert.equal(h.alarms.size, 0);
});

test('failed removal persists a completed restore across background reload and later cleanup', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async value => {
    if (value.backstash.stashes.length === 0) throw new Error('removal write failed');
    return set(value);
  };
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).cleanupPending);
  assert.equal(h.read().stashes[0].status, 'restored');
  await h.reload();
  await h.send('restore-all-stashes');
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes[0].status, 'restored');
  h.browser.storage.local.set = set;
  await h.reconcile();
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 0);
});

test('failed completion write uses live receipt, then requires review after losing background memory', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async value => {
    if (value.backstash.stashes.some(stash => stash.status === 'restored')) throw new Error('completion write failed');
    return set(value);
  };
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).cleanupPending);
  assert.equal(h.read().stashes[0].status, 'restoring');
  assert.equal((await h.send('list-stashes'))[0].status, 'restored');
  await h.send('restore-stash-now', { stashId: 'saved', confirmRestore: true });
  assert.equal(h.created.length, 1, 'live receipt overrides even an explicit retry');
  await h.reload();
  assert.equal((await h.send('list-stashes'))[0].status, 'restoring');
  const result = await h.send('restore-stash-now', { stashId: 'saved' });
  assert(!result.ok && result.requiresConfirmation);
  assert.equal((await h.send('restore-all-stashes')).failedCount, 1);
  await h.reconcile();
  assert.equal(h.created.length, 1, 'uncertain outcome must not automatically reopen');
  assert.equal(h.alarms.size, 0);
  h.browser.storage.local.set = set;
  assert((await h.send('cancel-stash', { stashId: 'saved' })).ok);
  assert.equal(h.created.length, 1, 'discarding an uncertain record leaves the opened tab alone');
});

test('a future uncertain restore is not rearmed and only an explicit retry may create a tab', async () => {
  const h = await harness();
  h.seed([{ ...item('uncertain'), status: 'restoring' }]);
  await h.reconcile();
  assert.equal(h.alarms.size, 0);
  assert.equal(h.created.length, 0);
  assert(!(await h.send('restore-stash-now', { stashId: 'uncertain', confirmRestore: 'true' })).ok);
  assert((await h.send('restore-stash-now', { stashId: 'uncertain', confirmRestore: true })).ok);
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 0);
});

test('a completed record is cleanup-only even when its tab ID is stale or its due time is future', async () => {
  const h = await harness();
  h.seed([{ ...item('completed'), status: 'restored', restoredTabId: 999 }]);
  h.browser.tabs.get = async () => { assert.fail('completed tab identity must not be interpreted across restart'); };
  await h.reload();
  assert.equal(h.created.length, 0);
  assert.equal(h.read().stashes.length, 0);
});

test('a known creation failure resets progress and can be retried normally', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async () => { throw new Error('window unavailable'); };
  assert(!(await h.send('restore-stash-now', { stashId: 'saved' })).ok);
  assert.equal(h.read().stashes[0].status, 'scheduled');
  h.browser.tabs.create = create;
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).ok);
  assert.equal(h.created.length, 1);
});

test('a failed creation whose progress cannot be reset remains safe after reload', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async () => { throw new Error('creation failed'); };
  const set = h.browser.storage.local.set;
  h.browser.storage.local.set = async value => {
    if (value.backstash.stashes.some(stash => stash.status === 'scheduled')) throw new Error('reset failed');
    return set(value);
  };
  assert(!(await h.send('restore-stash-now', { stashId: 'saved' })).ok);
  assert.equal(h.read().stashes[0].status, 'restoring');
  h.browser.tabs.create = create;
  h.browser.storage.local.set = set;
  await h.reload();
  assert((await h.send('restore-stash-now', { stashId: 'saved' })).requiresConfirmation);
  assert.equal(h.created.length, 0);
});

test('restore-all continues after cleanup failure and reports it separately from creation failure', async () => {
  const h = await harness();
  h.seed([item('cleanup'), item('good'), item('bad')]);
  const clear = h.browser.alarms.clear;
  h.browser.alarms.clear = async name => {
    if (name === 'restore-stash:cleanup') throw new Error('cleanup failed');
    return clear(name);
  };
  const create = h.browser.tabs.create;
  h.browser.tabs.create = async options => {
    if (options.url.endsWith('/bad')) throw new Error('creation failed');
    return create(options);
  };
  const result = await h.send('restore-all-stashes');
  assert.equal(result.restoredCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.cleanupPendingCount, 1);
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.read().stashes.map(stash => [stash.id, stash.status]), [['cleanup', 'restored'], ['bad', 'scheduled']]);
});

test('storage reads failing after creation cannot turn successful creation into another restore', async () => {
  const h = await harness();
  h.seed([item('saved')]);
  const get = h.browser.storage.local.get;
  h.browser.storage.local.get = async () => {
    if (h.created.length) throw new Error('storage unavailable');
    return get();
  };
  const result = await h.send('restore-stash-now', { stashId: 'saved' });
  assert(result.ok && result.cleanupPending);
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes[0].status, 'restoring');
  h.browser.storage.local.get = get;
  await h.reconcile();
  assert.equal(h.created.length, 1);
  assert.equal(h.read().stashes.length, 0);
});

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
  assert.equal(h.created.length, 0, 'reconciliation must respect retry timing');
  h.advance(60_000);
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
