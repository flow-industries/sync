# AGENTS.md

NOTE Sync is an Obsidian community plugin (id `flow-note`). This repository is public: keep in-house tooling, internal hosts and private links out of code, docs and commit messages.

- Use Bun 1.4.2. Before a PR, run `bun run lint`, `bun run typecheck`, `bun test` and `bun run build`.
- `manifest.json` stays at the root. Never change the plugin `id`. A release tag equals the manifest `version`, with no `v`.
- Keep Obsidian API calls in `src/obsidian/`; everything else is tested without Obsidian.
- Secrets (the device seed, Flow ID device tokens) live only in Obsidian's secret storage, never in `data.json` or anywhere inside the vault folder.
- Never execute note content. Notes, MDX and code blocks are text to this plugin.
- No WHAT comments; doc comments for exported APIs and short WHY comments only.
