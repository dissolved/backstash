function buildStashRestoreContext(tab) {
  return {
    originalWindowId: tab.windowId ?? null,
    originalTabIndex: Number.isInteger(tab.index) ? tab.index : null,
  };
}

function chooseRestoreWindowId({
  originalWindowId,
  existingWindowIds = [],
  lastFocusedWindowId = null,
}) {
  if (
    originalWindowId !== null &&
    existingWindowIds.includes(originalWindowId)
  ) {
    return originalWindowId;
  }

  return lastFocusedWindowId ?? null;
}

function chooseRestoreTabIndex({ originalTabIndex, tabCount }) {
  if (!Number.isInteger(originalTabIndex) || originalTabIndex < 0) {
    return null;
  }

  if (!Number.isInteger(tabCount) || tabCount < 0) {
    return null;
  }

  return Math.min(originalTabIndex, tabCount);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildStashRestoreContext,
    chooseRestoreWindowId,
    chooseRestoreTabIndex,
  };
}
