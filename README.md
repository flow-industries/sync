# NOTE Sync

An Obsidian plugin that keeps a vault in sync with your end-to-end encrypted [NOTE](https://note.flow.talk) notepad.

Work in progress: nothing syncs yet.

## Development

Use Bun 1.4.2.

```bash
bun install --frozen-lockfile
bun run build      # main.js at the repository root
bun run lint
bun run typecheck
bun test
```

To try it, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/flow-note/` and enable **NOTE Sync** under **Settings → Community plugins**.

## Releasing

`bun run version x.y.z` updates `package.json`, `manifest.json` and `versions.json`. Merge that, then push a tag named exactly `x.y.z`: the release workflow builds and attaches `main.js`, `manifest.json` and `styles.css` to a draft release.

## License

MIT
