const STORAGE_KEY = "backstash";

const DEFAULT_DATA = {
  schemaVersion: 1,
  stashes: [],
  settings: {
    restoreInBackground: true,
    showNotifications: true,
    stashPresetMinutes: [...BackstashConstants.DEFAULT_STASH_PRESET_MINUTES],
    defaultStashPresetMinutes:
      BackstashConstants.DEFAULT_STASH_PRESET_MINUTES[0],
  },
  state: {
    lastStashPresetMinutes: null,
    lastStashId: null,
  },
};

function cloneDefaultData() {
  return {
    schemaVersion: DEFAULT_DATA.schemaVersion,
    stashes: [...DEFAULT_DATA.stashes],
    settings: {
      ...DEFAULT_DATA.settings,
      stashPresetMinutes: [...DEFAULT_DATA.settings.stashPresetMinutes],
    },
    state: { ...DEFAULT_DATA.state },
  };
}

async function getData() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];
  const defaults = cloneDefaultData();

  if (!stored) {
    return defaults;
  }

  return {
    schemaVersion: stored.schemaVersion ?? defaults.schemaVersion,
    stashes: Array.isArray(stored.stashes) ? stored.stashes : [],
    settings: {
      ...defaults.settings,
      ...(stored.settings ?? {}),
    },
    state: {
      ...defaults.state,
      ...(stored.state ?? {}),
    },
  };
}

async function setData(data) {
  await browser.storage.local.set({ [STORAGE_KEY]: data });
}

async function getStashes() {
  const data = await getData();
  return data.stashes;
}

async function setStashes(stashes, statePatch = null) {
  const data = await getData();
  data.stashes = stashes;
  if (statePatch) data.state = { ...data.state, ...statePatch };
  await setData(data);
}

async function getSettings() {
  const data = await getData();
  return data.settings;
}

async function getState() {
  const data = await getData();
  return data.state;
}

async function updateState(patch) {
  const data = await getData();
  data.state = {
    ...data.state,
    ...patch,
  };
  await setData(data);
}

async function clearStashes() {
  const data = await getData();
  data.stashes = [];
  await setData(data);
}
