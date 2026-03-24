import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
        browser: "readonly",
        buildStashRestoreContext: "readonly",
        chooseRestoreWindowId: "readonly",
        chooseRestoreTabIndex: "readonly",
        getStashes: "readonly",
        setStashes: "readonly",
        getSettings: "readonly",
        updateState: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-console": "off",
    },
  },
  {
    files: ["storage.js"],
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
]);
