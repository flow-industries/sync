import { builtinModules } from "node:module";

/** Provided by Obsidian at runtime, or by Node and Electron on desktop. */
const external = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

const production = !process.argv.includes("--dev");
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: ".",
  naming: "main.js",
  target: "browser",
  format: "cjs",
  external,
  minify: production,
  sourcemap: production ? "none" : "inline",
  banner:
    "/* Bundled from https://github.com/flow-industries/sync; read the source there. */",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs)
  console.log(`${output.path} ${(output.size / 1024).toFixed(0)} KiB`);
