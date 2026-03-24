const STORAGE_KEY = "backstash";

const DEFAULT_DATA = {
  schemaVersion: 1,
  stashes: [],
  settings: {
    restoreInBackground: true,
    showNotifications: true,
    stashPresetMinutes: [...BackstashConstants.DEFAULT_STASH_PRESET_MINUTES],
    defaultStashPresetMinutes: BackstashConstants.DEFAULT_STASH_PRESET_MINUTES[0],
  },
  state: {
    lastStashPreset: null,
  },
};

function cloneDefaultData() {
  return {
    schemaVersion: DEFAULT_DATA.schemaVersion,
    stashes: [...DEFAULT_DATA.stashes],
    settings: { ...DEFAULT_DATA.settings },
    state: { ...DEFAULT_DATA.state },
  };
}

async function getData() {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY];

  if (!stored) {
    return cloneDefaultData();
  }

  return {
    schemaVersion: stored.schemaVersion ?? DEFAULT_DATA.schemaVersion,
    stashes: Array.isArray(stored.stashes) ? stored.stashes : [],
    settings: {
      ...DEFAULT_DATA.settings,
      ...(stored.settings ?? {}),
    },
    state: {
      ...DEFAULT_DATA.state,
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

async function setStashes(stashes) {
  const data = await getData();
  data.stashes = stashes;
  await setData(data);
}

async function getSettings() {
  const data = await getData();
  return data.settings;
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
