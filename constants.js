const DEFAULT_STASH_PRESET_MINUTES = [1, 60, 1440];

globalThis.BackstashConstants = {
  DEFAULT_STASH_PRESET_MINUTES,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    DEFAULT_STASH_PRESET_MINUTES,
  };
}
