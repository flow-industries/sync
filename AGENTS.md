# AGENTS.md

FLOW NOTE Sync is an Obsidian community plugin (id `flow-note`). This repository is public: keep in-house tooling, internal hosts and private links out of code, docs and commit messages.

- Use Bun 1.4.2. Before a PR, run `bun run lint`, `bun run lint:obsidian` (no errors), `bun run typecheck`, `bun test`, `bun run build` and `bun run smoke`.
- `manifest.json` stays at the root. Never change the plugin `id`. A release tag equals the manifest `version`, with no `v`.
- Obsidian's API is used only in `src/main.ts` and `src/obsidian/`. Everything else (path rules, the planner, the engine, custody, the controller) runs under `bun test`, and `tests/e2e.test.ts` drives the real device client against `@flow-industries/seal/testing`'s in-memory Flow ID and PDS. `bunfig.toml` preloads `fake-indexeddb` for it.
- `src/device.ts` is the only module that imports `@flow-industries/seal`.
- Secrets (the device seed, Flow ID device tokens) live only in Obsidian's secret storage, never in `data.json` or anywhere inside the vault folder. The plugin keeps no `data.json`.
- One device transport per credential store: `SyncController` owns the only open device vault, and a Web Lock on the vault's credential namespace keeps a second window from opening another. A closed device keeps the lock until `vault.stop()` settles, so a reopen never races a token refresh. The device client names its local database per device; unlink and removal delete it with `deleteDeviceStorage`, only after `stop()` settled.
- The sync index is per linked device (`indexName`), and every unlink, removal and new link deletes all of this vault's indexes first: a new device must never plan against another device's base. The controller drops every index save from an engine opened before an unlink or removal, and the engine saves a rename parked aside at once, so a quit mid-cycle still finishes it.
- Rounds start only after a `sync()` since the vault opened reported `read: true`: never plan uploads or deletions against a notepad the device hasn't read.
- Nothing syncs before the person confirms the linked account (`Custody.account()`).
- Every write to NOTE is compare-and-swap: saves pass `{ current: true }`, `rename` and `remove` pass the base the round read. A `NoteChangedError` means NOTE moved on, so the round reads again and plans from there; never retry the same write.
- Never execute note content. Notes, MDX and code blocks are text to this plugin, and nothing is ever written into Obsidian's config folder.
- `main.js` is loaded as CommonJS: `scripts/build.ts` replaces `import.meta.url`, and `bun run smoke` fails if the bundle needs anything at load beyond what Obsidian provides.
- No WHAT comments; doc comments for exported APIs and short WHY comments only.
