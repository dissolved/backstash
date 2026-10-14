// Runs only in the disposable test installation; production files are unchanged.
const assert = (value, message) => { if (!value) throw new Error(message); };
const send = (type, fields = {}) => browser.runtime.sendMessage({ type, ...fields });
const list = () => send('list-stashes');
const data = async () => (await browser.storage.local.get('backstash')).backstash;
const alarmName = id => `restore-stash:${id}`;

async function waitFor(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${message}`);
}

async function reset() {
  for (const alarm of await browser.alarms.getAll()) await browser.alarms.clear(alarm.name);
  await browser.storage.local.set({ backstash: {
    schemaVersion: 1, stashes: [],
    settings: { restoreInBackground: true, showNotifications: false },
    state: { lastStashPresetMinutes: null },
  } });
}

async function stash(url, options = {}, minutes = 10) {
  const tab = await browser.tabs.create({ url, ...options, active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  await waitFor(async () => { const current = await browser.tabs.get(tab.id); return current.status === 'complete' && current.url === url; }, 'fixture loaded');
  await waitFor(async () => (await browser.windows.getLastFocused()).id === tab.windowId, 'fixture window focused');
  const result = await send('stash-for-minutes', { minutes });
  assert(result.ok, `Stash rejected: ${result.error}; target=${JSON.stringify(tab)}; active=${JSON.stringify(await browser.tabs.query({active:true,currentWindow:true}))}`);
  const item = (await data()).stashes.find(item => item.url === url);
  assert(item, 'Stash not persisted');
  assert(!(await browser.tabs.query({ windowId: tab.windowId })).some(t => t.id === tab.id), 'Original tab not closed');
  assert(await browser.alarms.get(alarmName(item.id)), 'Restore alarm missing');
  return { tab, item };
}

async function restore(item) {
  const result = await send('restore-stash-now', { stashId: item.id });
  assert(result.ok, 'Restore failed');
  assert(!(await list()).some(i => i.id === item.id), 'Restored stash retained');
  assert(!await browser.alarms.get(alarmName(item.id)), 'Restored alarm retained');
  return browser.tabs.get(result.restoredTabId);
}

export async function restoreContexts(url) {
  await reset();
  const win = await browser.windows.create({ url: `${url}?anchor` });
  try {
    await browser.tabs.create({ windowId: win.id, url: `${url}?tail`, active: false });
    const original = await stash(`${url}?position`, { windowId: win.id, index: 1 });
    const restored = await restore(original.item);
    assert(restored.windowId === win.id && restored.index === 1, 'Original window/index lost');
    assert(!restored.active, 'Background restore stole selection');
    await browser.tabs.remove(restored.id);
    const clamped = await stash(`${url}?clamped`, { windowId: win.id });
    const tabs = await browser.tabs.query({ windowId: win.id });
    await browser.tabs.remove(tabs.slice(1).map(t => t.id));
    assert((await restore(clamped.item)).index === 1, 'Index not clamped to end');
    const fallback = await stash(`${url}?fallback`, { windowId: win.id });
    await browser.windows.remove(win.id);
    const controller = await browser.tabs.getCurrent();
    await browser.windows.update(controller.windowId, { focused: true });
    const recovered = await restore(fallback.item);
    assert(recovered.windowId === controller.windowId, 'Fallback window incorrect');
    await browser.tabs.remove(recovered.id);
  } finally {
    if ((await browser.windows.getAll()).some(w => w.id === win.id)) await browser.windows.remove(win.id);
  }
}

export async function containers(url) {
  await reset();
  // Firefox supplies built-in containers; no contextualIdentities permission needed.
  const saved = await stash(`${url}?container`, { cookieStoreId: 'firefox-container-1' });
  const restored = await restore(saved.item);
  assert(restored.cookieStoreId === saved.tab.cookieStoreId, 'Container lost');
  await browser.tabs.remove(restored.id);
  const fallback = await stash(`${url}?missing-container`);
  const stored = await data();
  stored.stashes[0].cookieStoreId = 'firefox-container-999999';
  await browser.storage.local.set({ backstash: stored });
  const plain = await restore(fallback.item);
  assert(plain.cookieStoreId === 'firefox-default', 'Unavailable container did not fall back');
  await browser.tabs.remove(plain.id);
}

export async function groups(url) {
  await reset();
  assert(browser.tabs.group && browser.tabGroups, 'This suite requires a Firefox version with tab groups');
  const anchor = await browser.tabs.create({ url: `${url}?group-anchor`, active: false });
  try {
    const groupId = await browser.tabs.group({ tabIds: anchor.id });
    const tab = await browser.tabs.create({ url: `${url}?grouped`, active: true });
    await browser.tabs.group({ groupId, tabIds: tab.id });
    await waitFor(async () => (await browser.tabs.get(tab.id)).url === `${url}?grouped`, 'group fixture loaded');
    assert((await send('stash-for-minutes', { minutes: 10 })).ok, 'Grouped stash failed');
    const item = (await data()).stashes[0];
    assert((await restore(item)).groupId === groupId, 'Original group not preserved');
    const missing = await stash(`${url}?missing-group`);
    const stored = await data();
    stored.stashes[0].originalGroupId = groupId;
    await browser.storage.local.set({ backstash: stored });
    await browser.tabs.ungroup((await browser.tabs.query({ groupId })).map(t => t.id));
    const restored = await restore(missing.item);
    assert(restored.groupId === browser.tabGroups.TAB_GROUP_ID_NONE, 'Missing group fallback failed');
    await browser.tabs.remove(restored.id);
  } finally {
    const tabs = await browser.tabs.query({});
    await browser.tabs.remove(tabs.filter(t => t.url?.startsWith(url + '?group')).map(t => t.id));
  }
}

export async function rejectedInputs() {
  await reset();
  const tab = await browser.tabs.create({ url: 'about:blank', active: true });
  try {
    assert(!(await send('stash-for-minutes', { minutes: 10 })).ok, 'Internal URL accepted');
    for (const minutes of [0, -1, 2.3, '15']) {
      assert(!(await send('stash-for-minutes', { minutes })).ok, 'Invalid duration accepted');
    }
    assert((await list()).length === 0 && (await browser.alarms.getAll()).length === 0, 'Rejected request created state');
  } finally { await browser.tabs.remove(tab.id); }
}

export async function popup(url) {
  await reset();
  // Render production popup in a tab. Suppress only window.close so assertions
  // can inspect the submitted form; native toolbar placement is a manual check.
  const originalClose = window.close;
  let closeCalled = false;
  window.close = () => { closeCalled = true; };
  try {
    document.getElementById('minutes-input').value = '2.3';
    document.getElementById('stash-form').requestSubmit();
    assert(document.getElementById('status-message').textContent.includes('15m'), 'Invalid duration feedback missing');
    for (const duration of ['15', '15m', '2h', '3d']) {
      const inputUrl = `${url}?input=${duration}`;
      const inputTab = await browser.tabs.create({ url: inputUrl, active: true });
      await waitFor(async () => (await browser.tabs.get(inputTab.id)).url === inputUrl, 'popup fixture loaded');
      document.getElementById('minutes-input').value = duration;
      closeCalled = false;
      document.getElementById('stash-form').requestSubmit();
      await waitFor(() => closeCalled, 'successful popup submission');
      // Closing/reopening the real popup normally resets this DOM state.
      document.getElementById('minutes-input').disabled = false;
      document.querySelector('#stash-form button').disabled = false;
    }
    const controller = await browser.tabs.getCurrent();
    await browser.tabs.update(controller.id, { active: true });
    // Production refresh runs on load; execute it through the existing page global.
    const unsorted = await data();
    unsorted.stashes.reverse();
    await browser.storage.local.set({ backstash: unsorted });
    await window.refreshStashes();
    const items = await list();
    const rows = [...document.querySelectorAll('.stash-item')];
    assert(rows.length === 4, 'Popup list missing stashes');
    assert(items.every((item, i) => !i || items[i - 1].wakeAt <= item.wakeAt), 'Stashes unsorted');
    assert(rows.every((row, i) => row.querySelector('.stash-title').textContent === items[i].title), 'Rendered order differs');
    rows[0].querySelector('button').click();
    await waitFor(() => document.querySelectorAll('.stash-item').length === 3, 'popup restore');
    document.querySelectorAll('.stash-item button')[1].click();
    await waitFor(() => document.querySelectorAll('.stash-item').length === 2, 'popup delete');
    assert(!await browser.alarms.get(alarmName(items[1].id)), 'Delete retained alarm');
    assert(!(await browser.tabs.query({})).some(t => t.url === items[1].url), 'Deleted stash reopened');
    document.getElementById('restore-all-button').click();
    await waitFor(() => document.querySelectorAll('.stash-item').length === 0, 'popup restore all');
    assert((await list()).length === 0 && (await browser.alarms.getAll()).length === 0, 'Restore all retained state');
    assert(document.getElementById('restore-all-button').disabled, 'Empty restore-all enabled');
  } finally { window.close = originalClose; }
}

export async function concurrency(url) {
  await reset();
  const token = crypto.randomUUID();
  const first = await stash(`${url}?concurrent-first=${token}`);
  const second = await stash(`${url}?concurrent-second=${token}`);
  const cancelled = await stash(`${url}?concurrent-cancelled=${token}`);
  const pendingUrl = `${url}?concurrent-new=${token}`;
  const pending = await browser.tabs.create({ url: pendingUrl, active: true });
  await browser.windows.update(pending.windowId, { focused: true });
  await waitFor(async () => {
    const tab = await browser.tabs.get(pending.id);
    return tab.url === pendingUrl && tab.status === 'complete';
  }, 'concurrent stash fixture loaded');
  // Submit all requests without awaiting them, from the same message sender.
  const results = await Promise.all([
    send('cancel-stash', { stashId: cancelled.item.id }),
    send('restore-stash-now', { stashId: first.item.id }),
    send('restore-all-stashes'),
    send('restore-stash-now', { stashId: second.item.id }),
    send('stash-for-minutes', { minutes: 15 }),
  ]);
  assert(results[0].ok && results[1].ok && results[2].ok && results[4].ok, 'Concurrent actions failed');
  const tabs = await browser.tabs.query({});
  for (const saved of [first, second]) {
    assert(tabs.filter(tab => tab.url === saved.item.url).length === 1, 'Concurrent restore duplicated or lost tab');
  }
  assert(!tabs.some(tab => tab.url === cancelled.item.url), 'Cancelled stash reopened');
  assert(!tabs.some(tab => tab.id === pending.id), 'New source tab not closed');
  const remaining = await list();
  assert(remaining.length === 1 && remaining[0].url === pendingUrl, 'Concurrent stash lost or old stash resurrected');
  const alarms = await browser.alarms.getAll();
  assert(alarms.length === 1 && alarms[0].name === alarmName(remaining[0].id), 'Concurrent actions left incorrect alarms');
  assert((await data()).state.lastStashPresetMinutes === 15, 'Concurrent stash lost repeat-last state');
  await send('cancel-stash', { stashId: remaining[0].id });
  await browser.tabs.remove(tabs.filter(tab => [first.item.url, second.item.url].includes(tab.url)).map(tab => tab.id));
}

async function stashSource(url) {
  const tab = await browser.tabs.create({ url, active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  await waitFor(async () => {
    const source = await browser.tabs.get(tab.id);
    return source.url === url && source.status === 'complete';
  }, 'stash failure fixture loaded');
  return tab;
}

async function faultyStash(url, mode) {
  const tab = await stashSource(url);
  await send('test-stash-fault', { fault: { mode, url, tabId: tab.id } });
  const result = await send('stash-for-minutes', { minutes: 10 });
  return { tab, result };
}

export async function stashFailures(url) {
  await reset();
  const token = crypto.randomUUID();
  const failedUrl = `${url}?source-close-failure=${token}`;
  let live;
  try {
    const failed = await faultyStash(failedUrl, 'close');
    live = failed.tab;
    assert(!failed.result.ok && (await list()).length === 0, 'Close failure retained an active stash');
    assert((await browser.tabs.get(live.id)).url === failedUrl, 'Close failure lost the source');
    assert((await data()).state.lastStashPresetMinutes === null, 'Failed stash changed repeat-last');
    assert((await browser.alarms.getAll()).length === 0, 'Close rollback retained alarm');
    await browser.tabs.remove(live.id);
    live = null;
    const savedUrl = `${url}?stash-finalize-failure=${token}`;
    const pending = await faultyStash(savedUrl, 'finalize');
    assert(!pending.result.ok && pending.result.stashSaved, 'Finalization failure did not retain a saved copy');
    assert(!(await browser.tabs.query({})).some(tab => tab.id === pending.tab.id), 'Confirmed source not closed');
    assert((await data()).stashes[0].status === 'stashing', 'Pending intent not durable');
    await window.refreshStashes();
    const row = document.querySelector('.stash-item');
    assert(row.querySelector('button').textContent === 'Finish scheduling', 'Live closure completion action missing');
    await send('test-stash-fault');
    row.querySelector('button').click();
    await waitFor(() => document.querySelector('.stash-item button')?.textContent === 'Restore', 'finish scheduling popup action');
    const saved = (await data()).stashes[0];
    const state = (await data()).state;
    assert(saved.status === 'scheduled' && state.lastStashPresetMinutes === 10 && state.lastStashId === saved.id, 'Finalization did not save state together');
    assert(await browser.alarms.get(alarmName(saved.id)), 'Finalization lost restore alarm');
    assert(!(await browser.tabs.query({})).some(tab => tab.url === savedUrl), 'Finalization prematurely restored the source');
    await send('cancel-stash', { stashId: saved.id });
  } finally {
    await send('test-stash-fault');
    if (live && (await browser.tabs.query({})).some(tab => tab.id === live.id)) await browser.tabs.remove(live.id);
  }
}

export async function prepareInterruptedStash(url) {
  await reset();
  const target = `${url}?interrupted-stash=${crypto.randomUUID()}`;
  try {
    const pending = await faultyStash(target, 'finalize');
    assert(!pending.result.ok && pending.result.stashSaved, 'Could not prepare interrupted stash');
    const item = (await data()).stashes[0];
    assert((await list())[0].status === 'stashed', 'Live closure receipt missing');
    return item;
  } finally { await send('test-stash-fault'); }
}

export async function verifyInterruptedStash(item) {
  const items = await list();
  assert(items.length === 1 && items[0].status === 'stashing', 'Reload incorrectly inferred source closure');
  await waitFor(async () => !await browser.alarms.get(alarmName(item.id)), 'uncertain stash alarm cleared on reload');
  assert(!(await browser.tabs.query({})).some(tab => tab.url === item.url), 'Uncertain stash restored automatically');
  assert(!(await send('restore-all-stashes')).ok, 'Bulk restore bypassed stash review');
  await window.refreshStashes();
  const row = document.querySelector('.stash-item');
  assert(row.querySelector('.stash-meta').textContent.includes('source tab may still be open'), 'Interrupted stash explanation missing');
  assert(row.querySelector('button').textContent === 'Restore saved copy', 'Explicit copy recovery action missing');
  row.querySelector('button').click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 0, 'explicit stash copy recovery');
  const restored = (await browser.tabs.query({})).filter(tab => tab.url === item.url);
  assert(restored.length === 1, 'Explicit copy recovery duplicated or lost tab');
  await browser.tabs.remove(restored[0].id);
}

export async function prepareRestoreRecovery(url) {
  await reset();
  const token = crypto.randomUUID();
  const completed = (await stash(`${url}?completed=${token}`)).item;
  const uncertainOpen = (await stash(`${url}?uncertain-open=${token}`)).item;
  const uncertainRetry = (await stash(`${url}?uncertain-retry=${token}`)).item;
  const opened = await browser.tabs.create({ url: completed.url, active: false });
  await browser.tabs.create({ url: uncertainOpen.url, active: false });
  const stored = await data();
  for (const item of stored.stashes) {
    item.status = item.id === completed.id ? 'restored' : 'restoring';
    item.restoredTabId = item.id === completed.id ? opened.id : null;
    if (item.id === uncertainOpen.id) item.wakeAt = 0;
  }
  await browser.storage.local.set({ backstash: stored });
  await window.refreshStashes();
  const items = await list();
  const row = document.querySelectorAll('.stash-item')[items.findIndex(item => item.id === completed.id)];
  assert(row.querySelector('button').textContent === 'Finish cleanup', 'Completed record offered another restore');
  row.querySelector('button').click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 2, 'completed popup cleanup');
  assert((await browser.tabs.query({})).filter(tab => tab.url === completed.url).length === 1, 'Popup cleanup duplicated a tab');
  assert(!await browser.alarms.get(alarmName(completed.id)), 'Popup cleanup retained alarm');
  // Put a completed record back to verify cleanup in a fresh background context.
  const remaining = await data();
  remaining.stashes.push(stored.stashes.find(item => item.id === completed.id));
  await browser.storage.local.set({ backstash: remaining });
  await browser.alarms.create(alarmName(completed.id), { when: Date.now() + 600000 });
  return { completed, uncertainOpen, uncertainRetry };
}

export async function verifyRestoreRecovery({ completed, uncertainOpen, uncertainRetry }) {
  const items = await list();
  assert(items.length === 2 && items.every(item => item.status === 'restoring'), 'Recovery state lost across extension reload');
  assert((await browser.alarms.getAll()).length === 0, 'Recovery records were rearmed or retained alarms');
  const count = async url => (await browser.tabs.query({})).filter(tab => tab.url === url).length;
  assert(await count(completed.url) === 1 && await count(uncertainOpen.url) === 1, 'Recovery reopened an existing tab');
  assert(await count(uncertainRetry.url) === 0, 'Uncertain attempt opened automatically');
  await window.refreshStashes();
  document.getElementById('restore-all-button').click();
  await waitFor(() => document.getElementById('status-message').textContent.includes('recovery actions'), 'bulk recovery feedback');
  assert((await list()).length === 2 && await count(uncertainRetry.url) === 0, 'Bulk restore retried an uncertain attempt');
  const retryIndex = (await list()).findIndex(item => item.id === uncertainRetry.id);
  const retryRow = document.querySelectorAll('.stash-item')[retryIndex];
  assert(retryRow.querySelector('.stash-meta').textContent.includes('Check your tabs'), 'Uncertain restore explanation missing');
  assert(retryRow.querySelector('button').textContent === 'Restore again', 'Explicit retry action missing');
  retryRow.querySelector('button').click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 1, 'explicit uncertain retry');
  assert(await count(uncertainRetry.url) === 1, 'Explicit retry failed');
  document.querySelectorAll('.stash-item button')[1].click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 0, 'dismiss uncertain record');
  assert(await count(uncertainOpen.url) === 1, 'Dismissing uncertainty closed the reopened tab');
  const urls = [completed.url, uncertainOpen.url, uncertainRetry.url];
  await browser.tabs.remove((await browser.tabs.query({})).filter(tab => urls.includes(tab.url)).map(tab => tab.id));
}

export async function prepareRetryState(url) {
  await reset();
  const token = crypto.randomUUID();
  const waiting = (await stash(`${url}?waiting-retry=${token}`)).item;
  const exhausted = (await stash(`${url}?exhausted-retry=${token}`)).item;
  const overdue = (await stash(`${url}?overdue-retry=${token}`)).item;
  const stored = await data();
  for (const item of stored.stashes) {
    item.wakeAt = 0;
    item.restoreFailureCount = item.id === waiting.id ? 2 : (item.id === exhausted.id ? 4 : 1);
    item.nextRetryAt = item.id === waiting.id ? Date.now() + 300000 : (item.id === exhausted.id ? null : Date.now() - 1000);
  }
  waiting.nextRetryAt = stored.stashes.find(item => item.id === waiting.id).nextRetryAt;
  await browser.storage.local.set({ backstash: stored });
  return { waiting, exhausted, overdue };
}

export async function verifyRetryState({ waiting, exhausted, overdue }) {
  const items = await list();
  assert(items.length === 2 && !items.some(item => item.id === overdue.id), 'Overdue retry not restored');
  assert((await browser.tabs.query({})).filter(tab => tab.url === overdue.url).length === 1, 'Overdue retry duplicated or lost');
  assert((await browser.alarms.get(alarmName(waiting.id))).scheduledTime === waiting.nextRetryAt, 'Reload ignored persisted retry timing');
  assert(!await browser.alarms.get(alarmName(exhausted.id)), 'Exhausted retry was rearmed');
  await window.refreshStashes();
  let rows = [...document.querySelectorAll('.stash-item')];
  const waitingRow = rows[items.findIndex(item => item.id === waiting.id)];
  const exhaustedRow = rows[items.findIndex(item => item.id === exhausted.id)];
  assert(waitingRow.querySelector('.stash-meta').textContent.includes('Retry due'), 'Retry timing missing from popup');
  assert(exhaustedRow.querySelector('.stash-meta').textContent.includes('retries stopped'), 'Exhaustion missing from popup');
  waitingRow.querySelectorAll('button')[1].click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 1, 'cancel pending retry');
  assert(!await browser.alarms.get(alarmName(waiting.id)), 'Cancelled retry alarm retained');
  rows = [...document.querySelectorAll('.stash-item')];
  rows[0].querySelector('button').click();
  await waitFor(() => document.querySelectorAll('.stash-item').length === 0, 'manual restore after exhaustion');
  const tabs = await browser.tabs.query({});
  assert(tabs.filter(tab => tab.url === exhausted.url).length === 1, 'Manual restore after exhaustion failed');
  assert(!tabs.some(tab => tab.url === waiting.url), 'Cancelled pending retry reopened');
  await browser.tabs.remove(tabs.filter(tab => [overdue.url, exhausted.url].includes(tab.url)).map(tab => tab.id));
}

export async function retryScheduling(url) {
  const pending = await prepareRetryAlarm(url);
  await window.refreshStashes();
  assert(document.querySelector('.stash-meta').textContent.includes('Retry due'), 'Known failure did not display retry timing');
  assert((await send('cancel-stash', { stashId: pending.id })).ok, 'Could not cancel a scheduled retry');
  assert(!await browser.alarms.get(alarmName(pending.id)), 'Retry cancellation retained alarm');
}

export async function prepareReconciliation(url) {
  await reset();
  const token = crypto.randomUUID();
  const future = await stash(`${url}?future=${token}`);
  const due = await stash(`${url}?due=${token}`);
  const stored = await data();
  stored.stashes.find(i => i.id === due.item.id).wakeAt = Date.now() - 1000;
  await browser.storage.local.set({ backstash: stored });
  await browser.alarms.clear(alarmName(future.item.id));
  await browser.alarms.clear(alarmName(due.item.id));
  await browser.alarms.create('restore-stash:orphan', { when: Date.now() + 600000 });
  return { future: future.item, due: due.item };
}

export async function verifyReconciliation({ future, due }) {
  await waitFor(async () => !(await list()).some(i => i.id === due.id), 'overdue restore on load');
  assert((await list()).some(i => i.id === future.id), 'Future stash lost across lifecycle');
  assert(await browser.alarms.get(alarmName(future.id)), 'Missing alarm not recreated');
  assert(!await browser.alarms.get('restore-stash:orphan'), 'Orphan alarm retained');
  assert((await browser.tabs.query({})).filter(t => t.url === due.url).length === 1, 'Overdue stash not restored exactly once');
  await send('cancel-stash', { stashId: future.id });
}

export async function prepareAlarm(url) {
  await reset();
  return (await stash(`${url}?real-alarm`, {}, 1)).item;
}

export async function prepareRetryAlarm(url) {
  await reset();
  const original = (await stash(`${url}?real-retry=${crypto.randomUUID()}`)).item;
  const stored = await data();
  // Firefox rejects javascript: in tabs.create. Exercise an actual API failure,
  // then fix the saved fixture URL without changing the production retry alarm.
  stored.stashes[0].url = 'javascript:void(0)';
  await browser.storage.local.set({ backstash: stored });
  const start = Date.now();
  const result = await send('restore-stash-now', { stashId: original.id });
  assert(!result.ok && result.retryScheduled, 'Actual creation failure did not schedule a retry');
  const pending = await data();
  const item = pending.stashes[0];
  assert(item.restoreFailureCount === 1 && item.nextRetryAt >= start + 60000 && item.nextRetryAt <= Date.now() + 60000, 'Incorrect first retry delay');
  assert((await browser.alarms.get(alarmName(item.id))).scheduledTime === item.nextRetryAt, 'Retry alarm does not match saved timing');
  item.url = original.url;
  await browser.storage.local.set({ backstash: pending });
  return item;
}

export async function alarmFinished(item) {
  if ((await list()).some(i => i.id === item.id)) return false;
  assert((await browser.tabs.query({})).filter(t => t.url === item.url).length === 1, 'Alarm did not restore exactly once');
  assert(!await browser.alarms.get(alarmName(item.id)), 'Fired alarm retained');
  return true;
}

export async function prepareWake(url) {
  await reset();
  const { item } = await stash(`${url}?wake`);
  await browser.alarms.clear(alarmName(item.id));
  return item;
}

export async function verifyWake(item) {
  assert((await list()).some(i => i.id === item.id), 'Wake lost stored stash');
  await waitFor(async () => !!await browser.alarms.get(alarmName(item.id)), 'wake reconciliation');
  assert((await data()).state.lastStashPresetMinutes === 10, 'Wake lost repeat-last state');
  await send('cancel-stash', { stashId: item.id });
}
