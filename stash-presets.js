const SHARED_DEFAULT_STASH_PRESET_MINUTES =
  typeof module !== "undefined" && module.exports
    ? require("./constants.js").DEFAULT_STASH_PRESET_MINUTES
    : globalThis.BackstashConstants.DEFAULT_STASH_PRESET_MINUTES;

function isValidDurationMinutes(minutes) {
  return Number.isInteger(minutes) && minutes > 0;
}

function normalizeStashPresetMinutes(presets) {
  if (!Array.isArray(presets)) {
    return [...SHARED_DEFAULT_STASH_PRESET_MINUTES];
  }

  const normalized = [];

  for (const preset of presets) {
    if (!isValidDurationMinutes(preset) || normalized.includes(preset)) {
      continue;
    }

    normalized.push(preset);
  }

  return normalized.length > 0
    ? normalized
    : [...SHARED_DEFAULT_STASH_PRESET_MINUTES];
}

function getDefaultStashPresetMinutes(settings = {}) {
  const presets = normalizeStashPresetMinutes(settings.stashPresetMinutes);

  if (presets.includes(settings.defaultStashPresetMinutes)) {
    return settings.defaultStashPresetMinutes;
  }

  return presets[0];
}

function getCommandStashPresetMinutes(command, settings = {}) {
  const match = /^duration-(\d+)$/.exec(command);
  if (!match) {
    return null;
  }

  const presetIndex = Number.parseInt(match[1], 10) - 1;
  if (!Number.isInteger(presetIndex) || presetIndex < 0) {
    return null;
  }

  const presets = normalizeStashPresetMinutes(settings.stashPresetMinutes);
  return presets[presetIndex] ?? null;
}

function getRepeatLastStashMinutes(state = {}) {
  return isValidDurationMinutes(state.lastStashPresetMinutes)
    ? state.lastStashPresetMinutes
    : null;
}

globalThis.BackstashPresets = {
  isValidDurationMinutes,
  getDefaultStashPresetMinutes,
  getCommandStashPresetMinutes,
  getRepeatLastStashMinutes,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_STASH_PRESET_MINUTES: SHARED_DEFAULT_STASH_PRESET_MINUTES,
    isValidDurationMinutes,
    normalizeStashPresetMinutes,
    getDefaultStashPresetMinutes,
    getCommandStashPresetMinutes,
    getRepeatLastStashMinutes,
  };
}
