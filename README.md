# FLOW NOTE Sync

An Obsidian plugin that keeps a vault in sync, both ways, with your end-to-end encrypted [NOTE](https://note.flow.talk) notepad. You approve it once in your browser; after that it syncs without asking for your passkey. Notes are encrypted on this device before they leave it.

FLOW NOTE Sync needs a Flow ID account with a NOTE notepad, and Obsidian 1.11.5 or later.

## Linking

1. Open **Settings → FLOW NOTE Sync** and select **Link**, or run **FLOW NOTE Sync: Link this vault** from the command palette.
2. The plugin shows a code and a 12-digit device code, and opens `note.flow.talk/link` in your browser.
3. On that page, sign in if asked, check the code, type the device code and approve with your passkey. The device code never leaves this device any other way: Flow ID only ever sees a slow hash of it, so it can't swap in keys or a notepad of its own.
4. Back in Obsidian, the plugin shows the account it was linked to (its handle, when the handle checks out both ways, and its DID). **Nothing syncs until you confirm it is yours.** A code someone else guessed and approved would otherwise bind your vault to their notepad.

A link has to be approved within ten minutes.

## What syncs

- **Notes and attachments:** every Markdown (`.md`) and MDX (`.mdx`) note, and every other file (images, PDFs, audio and the rest) up to 32 MB, both ways.
- **Renames** carry across, including folder renames. A rename the plugin didn't see (Obsidian was closed) is recognised by the file's unchanged content. When you rename an attachment here, Obsidian updates the links to it, and those edits sync like any other.
- **Deletions** move the file to the trash on the other side: Obsidian's trash here, NOTE's trash there. An edit beats a deletion: if one side edited a file the other deleted, it comes back. Before a sync would trash more than ten files and more than a tenth of the vault at once, the plugin asks.
- **Conflicts:** when both sides changed the same file, NOTE's version keeps the name and this vault's is saved beside it. A note's copy is named `<name> conflict <8 hex>.md`, the way NOTE names its own conflict copies; an attachment's keeps its extension last, `<name> conflict <8 hex>.png`, so Obsidian still opens it. Nothing is overwritten while you type: a file that changes during a sync, or an open note with unsaved typing, is left alone until the next sync. The same holds in NOTE: every write names the version it was planned from, so an edit that reaches NOTE during a sync is never replaced or trashed; the sync reads again and plans from there.

**Not synced:**

- Obsidian's config folder (`.obsidian/`) and anything hidden. The config folder holds plugin code, so nothing from NOTE is ever written into it.
- Attachments over 32 MB, names NOTE can't store (such as `con.md` or a name ending in a dot), names that differ from a synced file's only in case, and NOTE files whose names this vault can't hold. Settings lists them. A synced file that becomes one of these is left as it is on both sides, never deleted.

## Note content never runs

The plugin treats every note as text. It never evaluates MDX, code blocks or anything else in a note. Other plugins you install may: Dataview's JavaScript queries or Templater, for example, run code from notes, and with sync on, those notes can come from your other devices.

## Where the device key lives

Linking creates a device seed (the key that opens your notepad) and Flow ID device tokens. The plugin keeps them, the account you confirmed, and the access statement this device accepted, in Obsidian's secret storage. It never writes them to `data.json` or anywhere in the vault folder, which git and other sync tools copy. The plugin has no `data.json` at all.

| Platform | Where the secrets are kept |
| --- | --- |
| macOS | Obsidian's app data, encrypted with a key in the macOS Keychain (Electron `safeStorage`) |
| Windows | Obsidian's app data, encrypted with Windows DPAPI |
| Linux | Obsidian's app data, encrypted with your keyring (libsecret or KWallet) |
| Linux without a keyring | Obsidian's app data, **unencrypted**: the plugin says so and asks before linking |
| iOS | The iOS Keychain, through Obsidian's native secure storage |
| Android | Android's secure storage, through Obsidian's native secure storage |

Trade-offs to know:

- **Plugins aren't isolated from each other.** Any plugin you install runs with the same access as this one and could read Obsidian's secret storage. Install plugins you trust.
- **Mobile secret storage is shared by every vault on the device**, so each vault's link lives under its own random name.
- **On mobile, Obsidian saves a secret in the background.** Flow ID rotates the refresh token on every refresh; if the app is killed in the instant between a refresh and that save, the next start presents the old token, Flow ID refuses it, and you link again. Nothing is lost: your notes are on both sides.

The plugin also keeps two caches in Obsidian's app data, never in the vault: the device client's encrypted local database, named for this device alone, and an index of what was last synced.

## Removing access

- **Unlink** (in settings or the command palette) stops syncing and forgets the device seed, its tokens, its local database and the sync index on this device. Your files stay. Remove the device under **Access** in NOTE too.
- **Removing the device** under Access in NOTE, or Flow ID revoking it, stops the plugin at its next sync: it wipes the same, writes nothing more, and asks you to link again. Your files stay.

## Network use

- **id.flow.industries** (Flow ID): links the device, refreshes its tokens, and relays your encrypted notepad to and from your PDS. Only the device name, its public keys, a slow hash of the device code and ciphertext leave this device.
- **note.flow.talk**: opened in your browser to approve the link. The plugin itself doesn't contact it.
- **plc.directory**, or a `did:web` account's own domain, and **your handle's domain** (`https://<handle>/.well-known/atproto-did`): read once at linking to show the account's handle.

The plugin sends no telemetry.

## Development

Use Bun 1.4.2.

```bash
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun test           # unit tests and the end-to-end run against an in-memory Flow ID and PDS
bun run build      # main.js at the repository root
bun run smoke      # loads main.js as Obsidian does, with no Node modules
```

Obsidian's API is used only under `src/obsidian/` and `src/main.ts`; everything else runs under `bun test`. To try a build, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/flow-note/` and enable **FLOW NOTE Sync** under **Settings → Community plugins**.

## Releasing

`bun run version x.y.z` updates `package.json`, `manifest.json` and `versions.json`. Merge that, then push a tag named exactly `x.y.z`: the release workflow checks it, builds, and attaches `main.js`, `manifest.json` and `styles.css` to a draft release.

## License

MIT
