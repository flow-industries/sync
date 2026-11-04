# AGENTS.md

NOTE Sync is an Obsidian community plugin (id `flow-note`). This repository is public: keep in-house tooling, internal hosts and private links out of code, docs and commit messages.

- Use Bun 1.4.2. Before a PR, run `bun run lint`, `bun run typecheck`, `bun test`, `bun run build` and `bun run smoke`.
- `manifest.json` stays at the root. Never change the plugin `id`. A release tag equals the manifest `version`, with no `v`.
- Obsidian's API is used only in `src/main.ts` and `src/obsidian/`. Everything else (path rules, the planner, the engine, custody, the controller) runs under `bun test`, and `tests/e2e.test.ts` drives the real device client from `@flow-industries/seal` against its in-memory Flow ID and PDS.
- `src/device.ts` is the only module that imports `@flow-industries/seal`.
- Secrets (the device seed, Flow ID device tokens) live only in Obsidian's secret storage, never in `data.json` or anywhere inside the vault folder. The plugin keeps no `data.json`.
- One device transport per credential store: `SyncController` owns the only open device vault, and a Web Lock keeps a second window or vault from opening the same account.
- Nothing syncs before the person confirms the linked account (`Custody.account()`).
- Never execute note content. Notes, MDX and code blocks are text to this plugin, and nothing is ever written into Obsidian's config folder.
- `main.js` is loaded as CommonJS: `scripts/build.ts` replaces `import.meta.url`, and `bun run smoke` fails if the bundle needs anything at load beyond what Obsidian provides.
- No WHAT comments; doc comments for exported APIs and short WHY comments only.
