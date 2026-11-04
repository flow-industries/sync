import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/** The rules Obsidian's community-plugin review runs; Biome covers everything else. */
export default [
  { ignores: ["main.js", "node_modules/", "scripts/", "tests/"] },
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
];
