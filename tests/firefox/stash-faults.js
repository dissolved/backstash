// Loaded only by scripts/firefox-checks.py's disposable test package.
// Production scripts and the checked-in manifest do not load these fault hooks.
let stashTestFault = null;
const stashTestSet = browser.storage.local.set.bind(browser.storage.local);
const stashTestRemove = browser.tabs.remove.bind(browser.tabs);

browser.storage.local.set = async value => {
  if (stashTestFault?.mode === "finalize" && value.backstash?.stashes?.some(
    item => item.url === stashTestFault.url && item.status === "scheduled",
  )) {
    throw new Error("Injected stash finalization failure");
  }
  return stashTestSet(value);
};

browser.tabs.remove = async tabIds => {
  const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
  if (stashTestFault?.mode === "close" && ids.includes(stashTestFault.tabId)) {
    throw new Error("Injected source tab closure failure");
  }
  return stashTestRemove(tabIds);
};

browser.runtime.onMessage.addListener(message => {
  if (message?.type !== "test-stash-fault") return false;
  stashTestFault = message.fault ?? null;
  return Promise.resolve({ ok: true });
});
