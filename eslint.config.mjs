import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/** The rules Obsidian's community-plugin review runs; Biome covers everything else. */
export default [
  { ignores: ["main.js", "node_modules/"] },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["NOTE", "Flow ID"],
          ignoreWords: ["Access"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Build scripts and tests run under Bun, never in Obsidian, and tests pass the config folder's name on purpose.
    files: ["scripts/**/*.ts", "tests/**/*.ts"],
    languageOptions: { globals: { Bun: "readonly", process: "readonly" } },
    rules: {
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/no-nodejs-modules": "off",
      "obsidianmd/prefer-window-timers": "off",
    },
  },
];
