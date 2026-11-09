import { type App, MarkdownView, normalizePath, Platform } from "obsidian";
import type { SecretBackend } from "../custody";
import type { LocalVault } from "../engine";
import { parentOf, pathKey } from "../paths";

const arrayBufferOf = (bytes: Uint8Array) =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

/** The Obsidian vault through its Vault API; renames never rewrite links, since NOTE already repaired them. */
export function obsidianVault(app: App): LocalVault {
  const { vault, fileManager } = app;
  const fileAt = (path: string) => vault.getFileByPath(normalizePath(path));
  const free = async (path: string) =>
    !vault.getAbstractFileByPath(path) && !(await vault.adapter.exists(path));
  /** An editor holding text it hasn't saved yet: writing under it could lose the typing. */
  const unsaved = (path: string, disk: string) =>
    app.workspace
      .getLeavesOfType("markdown")
      .some(
        (leaf) =>
          leaf.view instanceof MarkdownView &&
          leaf.view.file?.path === path &&
          leaf.view.getViewData() !== disk,
      );
  const ensureFolder = async (path: string) => {
    const folder = parentOf(path);
    if (folder && !vault.getAbstractFileByPath(folder))
      await vault.createFolder(folder);
  };
  return {
    async list() {
      return vault.getFiles().map((file) => ({
        path: file.path,
        mtime: file.stat.mtime,
        size: file.stat.size,
      }));
    },
    async read(path) {
      const file = fileAt(path);
      if (!file) throw new Error(`${path} is gone`);
      return vault.read(file);
    },
    async readBinary(path) {
      const file = fileAt(path);
      if (!file) throw new Error(`${path} is gone`);
      return new Uint8Array(await vault.readBinary(file));
    },
    async create(path, body) {
      const target = normalizePath(path);
      if (!(await free(target))) return false;
      await ensureFolder(target);
      if (typeof body === "string") await vault.create(target, body);
      else await vault.createBinary(target, arrayBufferOf(body));
      return true;
    },
    async overwrite(path, bytes) {
      const file = fileAt(path);
      if (!file) throw new Error(`${path} is gone`);
      await vault.modifyBinary(file, arrayBufferOf(bytes));
    },
    async replace(path, expected, next) {
      const file = fileAt(path);
      if (!file) return false;
      let replaced = false;
      await vault.process(file, (current) => {
        if (current !== expected || unsaved(file.path, current)) return current;
        replaced = true;
        return next;
      });
      return replaced;
    },
    async move(from, to) {
      const file = fileAt(from);
      const target = normalizePath(to);
      const caseOnly = pathKey(from) === pathKey(target);
      if (!file || (!caseOnly && !(await free(target)))) return false;
      await ensureFolder(target);
      await vault.rename(file, target);
      return true;
    },
    async trash(path) {
      const file = fileAt(path);
      if (!file) return;
      if (unsaved(file.path, await vault.read(file)))
        throw new Error(`${path} has unsaved changes`);
      await fileManager.trashFile(file);
    },
  };
}

type Secrets = App["secretStorage"] & {
  deleteSecret?(id: string): boolean;
  isEncryptionAvailable?(): boolean;
};

/** Obsidian's secret storage, kept outside the vault folder in the app's own storage. */
export function obsidianSecrets(app: App): SecretBackend {
  const storage: Secrets = app.secretStorage;
  return {
    get: (id) => storage.getSecret(id) || null,
    set: (id, value) => storage.setSecret(id, value),
    delete: (id) => {
      if (storage.deleteSecret) storage.deleteSecret(id);
      else storage.setSecret(id, "");
    },
  };
}

/** Where this platform's secret storage keeps the device's keys, in words for settings. */
export function custodyNote(app: App): { text: string; safe: boolean } {
  const storage: Secrets = app.secretStorage;
  if (Platform.isIosApp)
    return {
      text: "Stored in the iOS Keychain through Obsidian's secret storage.",
      safe: true,
    };
  if (Platform.isAndroidApp)
    return {
      text: "Stored in Android's Keystore-backed secure storage through Obsidian's secret storage.",
      safe: true,
    };
  const keychain = Platform.isMacOS
    ? "the macOS Keychain"
    : Platform.isWin
      ? "Windows DPAPI"
      : "your keyring (libsecret or KWallet)";
  const encrypted = storage.isEncryptionAvailable?.();
  if (encrypted === undefined && Platform.isLinux)
    return {
      text: "Obsidian's secret storage encrypts the device key with your keyring (libsecret or KWallet) when it finds one; this version of Obsidian doesn't say whether it did. Without one, the key is kept unencrypted in Obsidian's app data, outside the vault.",
      safe: false,
    };
  if (encrypted === false)
    return {
      text: "Obsidian can't reach a keyring on this computer, so its secret storage keeps the device key unencrypted in Obsidian's app data, outside the vault. Install a keyring (libsecret or KWallet) before linking to have it encrypted.",
      safe: false,
    };
  return {
    text: `Encrypted with ${keychain} through Obsidian's secret storage, in Obsidian's app data outside the vault.`,
    safe: true,
  };
}

/** A random name for this vault's link on this device, kept in Obsidian's per-vault local storage, never in the vault folder. */
export function deviceNamespace(app: App): string {
  const key = "flow-note-device";
  const saved: unknown = app.loadLocalStorage(key);
  if (typeof saved === "string" && /^[0-9a-f]{16}$/u.test(saved)) return saved;
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  app.saveLocalStorage(key, fresh);
  return fresh;
}

/** The label NOTE shows for this vault under Access. */
export function defaultLabel(): string {
  const platform = Platform.isIosApp
    ? "iOS"
    : Platform.isAndroidApp
      ? "Android"
      : Platform.isMacOS
        ? "macOS"
        : Platform.isWin
          ? "Windows"
          : Platform.isLinux
            ? "Linux"
            : "this device";
  return `Obsidian on ${platform}`;
}

/**
 * Whether Obsidian rewrites links as it renames a file here: its
 * "Automatically update internal links" setting, which the API reads only
 * through the vault's config. Unknown counts as no, so NOTE repairs them.
 */
export function updatesLinks(app: App): boolean {
  const vault = app.vault as typeof app.vault & {
    getConfig?: (key: string) => unknown;
  };
  return vault.getConfig?.("alwaysUpdateLinks") === true;
}
