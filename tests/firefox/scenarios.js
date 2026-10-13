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
