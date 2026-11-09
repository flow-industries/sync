import { afterEach, describe, expect, test } from "bun:test";
import {
  type AdminBrowser,
  adminBrowser,
  approveLink,
  dropDevices,
  type FakeFlowId,
  fakeFlowId,
  memoryStore,
  openAdminVault,
  TEST_DID,
  TEST_HOST,
} from "@flow-industries/seal/testing";
import { REMOVED, SyncController } from "../src/controller";
import { Custody, type SecretBackend } from "../src/custody";
import {
  createDeviceSeed,
  type DeviceCheckpoint,
  deleteDeviceStorage,
  followsRead,
  isStaleWrite,
  type LinkPrompt,
  linkDevice,
  type NoteDeviceCredentials,
  type NoteDeviceFetch,
  openDeviceVault,
  SYNC_LOCKED,
  type TrustLoss,
} from "../src/device";
import { SyncEngine, type SyncIndex } from "../src/engine";
import { linkPageFor } from "../src/link-page";
import { MemoryIndex, MemoryVault } from "./fakes";

/**
 * Two Obsidian vaults linked as two devices of one NOTE notepad, syncing
 * through the device client against seal's in-memory Flow ID and PDS. Each
 * device keeps its own local database; the vaults take turns so each step's
 * order is fixed.
 */
class Secrets implements SecretBackend {
  values = new Map<string, string>();
  get = (id: string) => this.values.get(id) ?? null;
  set = (id: string, value: string) => void this.values.set(id, value);
  delete = (id: string) => void this.values.delete(id);
}

function obsidian(note: FakeFlowId, name: string) {
  const local = new MemoryVault();
  /** Obsidian's "Automatically update internal links". */
  const links = { updated: true };
  const secrets = new Secrets();
  const custody = new Custody(secrets, `${name}0000000000`);
  const indexes = new Map<string, SyncIndex>();
  const prompts: LinkPrompt[] = [];
  const losses: TrustLoss[] = [];
  const notices: string[] = [];
  const controller: SyncController = new SyncController({
    custody,
    device: {
      createDeviceSeed,
      linkDevice,
      openDeviceVault,
      locked: SYNC_LOCKED,
      followsRead,
      stale: isStaleWrite,
    },
    host: TEST_HOST,
    fetch: (url, init) => note.fetch(url, init),
    local,
    configDir: ".obsidian",
    updatesLinks: () => links.updated,
    indexFor: (key) => {
      const name = JSON.stringify(key);
      const index = indexes.get(name) ?? new MemoryIndex();
      indexes.set(name, index);
      return index;
    },
    forgetIndexes: async () => indexes.clear(),
    hold: async () => () => {},
    forgetDevice: deleteDeviceStorage,
    confirmDeletions: async () => true,
    onChange: () => {
      if (controller?.phase.kind === "linking" && controller.phase.prompt)
        prompts.push(controller.phase.prompt);
    },
    onTrustLoss: (loss) => losses.push(loss),
    notify: (message) => notices.push(message),
  });
  /** Opens this vault's link, lets `work` run, then closes it for the other vault's turn. */
  async function turn(work: () => Promise<void> = async () => {}) {
    await controller.start();
    expect(controller.phase.kind).toBe("open");
    await controller.syncNow();
    await work();
    await controller.syncNow();
    controller.close();
  }
  return {
    local,
    links,
    secrets,
    custody,
    controller,
    prompts,
    losses,
    notices,
    turn,
  };
}
type Obsidian = ReturnType<typeof obsidian>;

async function link(admin: AdminBrowser, vault: Obsidian) {
  const linking = vault.controller.link(
    "Obsidian on test",
    new AbortController().signal,
  );
  while (!vault.prompts.length)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const [prompt] = vault.prompts;
  if (!prompt) throw new Error("No prompt");
  // The test Flow ID answers with its own verification address; neither seal nor the plugin passes it on.
  expect(linkPageFor(prompt.userCode)).toBe(
    "https://note.flow.talk/link?code=BCDF-GHJK",
  );
  expect(prompt.linkPage).toBe(linkPageFor(prompt.userCode));
  expect(prompt.pairingCode).toMatch(
    /^[0-9A-HJKMNP-TV-Z]{4} [0-9A-HJKMNP-TV-Z]{4}$/,
  );
  await approveLink(admin, prompt);
  return linking;
}

const opened: Obsidian[] = [];
afterEach(() => {
  for (const vault of opened.splice(0)) vault.controller.close();
});

describe("two Obsidian vaults synced through NOTE", () => {
  test("link, confirm the account, sync both ways, rename, resolve a conflict, and stop on revocation", async () => {
    const note = fakeFlowId();
    const admin = await adminBrowser(note);
    const a = obsidian(note, "aaaaaa");
    const b = obsidian(note, "bbbbbb");
    opened.push(a, b);

    a.local.put("Inbox/First.md", "# Written in vault A");
    a.local.put("Code.mdx", "export const x = 1\n\n<Never runs here />");
    const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    a.local.put("img/photo.png", photo);
    const account = await link(admin, a);
    expect(account.did).toBe(TEST_DID);
    expect(a.controller.phase.kind).toBe("confirm");
    // Linked but unconfirmed: a restart still asks, and nothing has synced.
    await a.controller.start();
    expect(a.controller.phase.kind).toBe("confirm");
    expect(a.custody.account()).toBeNull();
    await a.controller.confirm();
    expect(a.custody.account()).toEqual({ did: TEST_DID });
    await a.controller.syncNow();
    a.controller.close();

    await link(admin, b);
    await b.controller.confirm();
    await b.controller.syncNow();
    b.controller.close();
    expect(b.local.text("Inbox/First.md")).toBe("# Written in vault A");
    expect(b.local.text("Code.mdx")).toBe(
      "export const x = 1\n\n<Never runs here />",
    );
    expect(b.local.files.get("img/photo.png")?.body).toEqual(photo);

    // A note written in NOTE itself, signed by the passkey, reaches both vaults.
    const web = await openAdminVault(admin);
    await web.sync();
    await web.save({
      id: crypto.randomUUID(),
      path: "From NOTE.md",
      source: "# Written in NOTE",
      kind: "md",
    });
    await web.sync();
    web.lock();
    await a.turn();
    expect(a.local.text("From NOTE.md")).toBe("# Written in NOTE");

    await b.turn(async () => {
      b.local.put("Inbox/First.md", "# Edited in vault B");
      b.local.put("From B.md", "new in B");
    });
    await a.turn();
    expect(a.local.text("Inbox/First.md")).toBe("# Edited in vault B");
    expect(a.local.text("From B.md")).toBe("new in B");

    await a.turn(async () => {
      await a.local.move("From B.md", "Archive/From B.md");
      a.controller.renamed("From B.md", "Archive/From B.md");
    });
    await b.turn();
    expect(b.local.text("From B.md")).toBeUndefined();
    expect(b.local.text("Archive/From B.md")).toBe("new in B");

    await a.turn(async () => a.local.put("Inbox/First.md", "A's edit"));
    b.local.put("Inbox/First.md", "B's edit");
    await b.turn();
    await a.turn();
    for (const vault of [a, b]) {
      expect(vault.local.text("Inbox/First.md")).toBe("A's edit");
      const copies = [...vault.local.files.keys()].filter((path) =>
        /^Inbox\/First conflict [0-9a-f]{8}\.md$/u.test(path),
      );
      expect(copies.length).toBe(1);
      expect(vault.local.text(copies[0] ?? "")).toBe("B's edit");
    }
    expect(note.violations).toEqual([]);

    note.revokeAll();
    await a.controller.start();
    expect(a.controller.phase.kind).toBe("removed");
    expect(a.custody.seed()).toBeNull();
    expect(await a.custody.credentials.read()).toBeNull();
    a.local.put("After.md", "never leaves");
    await a.controller.syncNow();
    expect(a.controller.phase.kind).toBe("removed");

    const databases = async () =>
      (await indexedDB.databases()).filter((db) =>
        db.name?.startsWith("flow-note:"),
      ).length;
    const before = await databases();
    await b.controller.unlink();
    expect(b.controller.phase.kind).toBe("unlinked");
    expect(await databases()).toBeLessThan(before);
    expect(b.secrets.values.has("flow-note-bbbbbb0000000000-seed")).toBe(false);
    expect(b.secrets.values.has("flow-note-bbbbbb0000000000-tokens")).toBe(
      false,
    );
  }, 120_000);

  test("a vault removed under Access while syncing stops and wipes its keys, keeping its files", async () => {
    const note = fakeFlowId();
    const admin = await adminBrowser(note);
    const a = obsidian(note, "cccccc");
    opened.push(a);
    a.local.put("Kept.md", "synced before removal");
    await link(admin, a);
    await a.controller.confirm();
    await a.controller.syncNow();
    expect(a.controller.phase.kind).toBe("open");

    await dropDevices(admin);
    a.local.put("Late.md", "written after removal");
    await a.controller.syncNow();
    for (
      let wait = 0;
      a.controller.phase.kind !== "removed" && wait < 100;
      wait++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.controller.phase).toEqual({
      kind: "removed",
      message: REMOVED.removed,
    });
    expect(a.custody.seed()).toBeNull();
    expect(await a.custody.credentials.read()).toBeNull();
    expect(await a.custody.checkpoints.read()).not.toBeNull();
    expect(a.local.text("Kept.md")).toBe("synced before removal");
    expect(a.local.text("Late.md")).toBe("written after removal");
    const web = await openAdminVault(admin);
    await web.sync();
    expect((await web.read()).notes.map((item) => item.path)).toEqual([
      "Kept.md",
    ]);
    web.lock();
    expect(note.violations).toEqual([]);
  }, 60_000);

  test("an edit that reaches the device mid-round becomes a conflict copy, never overwritten", async () => {
    const note = fakeFlowId();
    const admin = await adminBrowser(note);
    const seed = createDeviceSeed();
    const options = {
      host: TEST_HOST,
      fetch: ((url, init) => note.fetch(url, init)) satisfies NoteDeviceFetch,
      credentials: memoryStore<NoteDeviceCredentials>(),
      checkpoints: memoryStore<DeviceCheckpoint>(),
    };
    const prompt = Promise.withResolvers<LinkPrompt>();
    const linking = linkDevice(seed, {
      ...options,
      label: "Obsidian on test",
      onPrompt: prompt.resolve,
    });
    await approveLink(admin, await prompt.promise);
    await linking;
    const device = await openDeviceVault(seed, options);
    const web = await openAdminVault(admin);
    try {
      const local = new MemoryVault();
      const index = new MemoryIndex();
      local.put("Plan.md", "first");
      const engine = new SyncEngine({
        local,
        remote: device,
        index,
        configDir: ".obsidian",
        stale: isStaleWrite,
      });
      await engine.load();
      await engine.run();
      await device.sync();

      // NOTE's edit lands in the device's copy after the round has read it, but before it pushes.
      local.put("Plan.md", "edited here");
      let interleave = true;
      const remote: typeof device = {
        ...device,
        read: async () => {
          const view = await device.read();
          if (interleave) {
            interleave = false;
            await web.sync();
            const plan = (await web.read()).notes.find(
              (item) => item.path === "Plan.md",
            );
            if (!plan) throw new Error("Missing Plan.md");
            await web.save({ ...plan, source: "edited in NOTE" });
            await web.sync();
            await device.sync();
          }
          return view;
        },
      };
      const racing = new SyncEngine({
        local,
        remote,
        index,
        configDir: ".obsidian",
        stale: isStaleWrite,
      });
      await racing.load();
      await racing.run();
      const copy = [...local.files.keys()].find((path) =>
        path.startsWith("Plan conflict "),
      );
      expect(local.text("Plan.md")).toBe("edited in NOTE");
      expect(local.text(copy ?? "")).toBe("edited here");
      await device.sync();
      await web.sync();
      const sources = new Map(
        (await web.read()).notes.map((item) => [item.path, item.source]),
      );
      expect(sources.get("Plan.md")).toBe("edited in NOTE");
      expect(sources.get(copy ?? "")).toBe("edited here");
    } finally {
      web.lock();
      await device.stop();
    }
  }, 60_000);
});

/**
 * With "Automatically update internal links" on, Obsidian rewrites a third
 * note's links for the new names, and the plugin pushes that edit before the
 * renames. Those renames skip NOTE's link repair: repairing again would
 * re-target the links in a chain or a swap. A rename Obsidian didn't see, or
 * made with link updates off, has NOTE repair them instead.
 */
describe("links in another note across renames made in Obsidian", () => {
  async function linkedWith(files: Record<string, string>) {
    const note = fakeFlowId();
    const admin = await adminBrowser(note);
    const vault = obsidian(note, "dddddd");
    opened.push(vault);
    for (const [path, text] of Object.entries(files))
      vault.local.put(path, text);
    await link(admin, vault);
    await vault.controller.confirm();
    await vault.controller.syncNow();
    return vault;
  }
  const linkedWithIndex = () =>
    linkedWith({
      "Alpha.md": "alpha",
      "Beta.md": "beta",
      "Index.md": "first [[Alpha]] then [[Beta]]",
    });
  /** Renames as Obsidian does, rewriting Index.md's links after each one. */
  async function rename(
    vault: Obsidian,
    from: string,
    to: string,
    index: string,
  ) {
    await vault.local.move(from, to);
    vault.controller.renamed(from, to);
    vault.local.put("Index.md", index);
  }
  async function settle(vault: Obsidian) {
    for (let round = 0; round < 3; round++) await vault.controller.syncNow();
    await Bun.sleep(20);
    await vault.controller.syncNow();
  }

  test("a rename Obsidian didn't see has NOTE repair them", async () => {
    const vault = await linkedWith({
      "Alpha.md": "alpha",
      "Index.md": "see [[Alpha]]",
    });
    // Made in the file manager, or while Obsidian was closed: no rename event, no link updates.
    await vault.local.move("Alpha.md", "Zeta.md");
    await settle(vault);
    expect(vault.local.text("Zeta.md")).toBe("alpha");
    expect(vault.local.text("Index.md")).toMatch(/^see \[\[\/?Zeta\]\]$/u);
  }, 60_000);

  test("a rename with Obsidian's link updates off has NOTE repair them", async () => {
    const vault = await linkedWith({
      "Alpha.md": "alpha",
      "Index.md": "see [[Alpha]]",
    });
    vault.links.updated = false;
    await vault.local.move("Alpha.md", "Zeta.md");
    vault.controller.renamed("Alpha.md", "Zeta.md");
    await settle(vault);
    expect(vault.local.text("Index.md")).toMatch(/^see \[\[\/?Zeta\]\]$/u);
  }, 60_000);

  test("an MDX note's links, which Obsidian never updates, follow a rename it made", async () => {
    const vault = await linkedWith({
      "Alpha.md": "alpha",
      "Index.mdx": "see [[Alpha]]",
    });
    await vault.local.move("Alpha.md", "Zeta.md");
    vault.controller.renamed("Alpha.md", "Zeta.md");
    await settle(vault);
    expect(vault.local.text("Index.mdx")).toMatch(/^see \[\[\/?Zeta\]\]$/u);
  }, 60_000);

  test("a single rename keeps them on the right notes", async () => {
    const vault = await linkedWithIndex();
    await rename(vault, "Alpha.md", "Zeta.md", "first [[Zeta]] then [[Beta]]");
    await settle(vault);
    expect(vault.local.text("Zeta.md")).toBe("alpha");
    expect(vault.local.text("Index.md")).toBe("first [[Zeta]] then [[Beta]]");
  }, 60_000);

  test("a chain keeps them on the right notes", async () => {
    const vault = await linkedWithIndex();
    await rename(
      vault,
      "Beta.md",
      "Gamma.md",
      "first [[Alpha]] then [[Gamma]]",
    );
    await rename(vault, "Alpha.md", "Beta.md", "first [[Beta]] then [[Gamma]]");
    await settle(vault);
    expect(vault.local.text("Beta.md")).toBe("alpha");
    expect(vault.local.text("Gamma.md")).toBe("beta");
    expect(vault.local.text("Index.md")).toBe("first [[Beta]] then [[Gamma]]");
  }, 60_000);

  test("a swap keeps them on the right notes", async () => {
    const vault = await linkedWithIndex();
    await rename(vault, "Alpha.md", "tmp.md", "first [[tmp]] then [[Beta]]");
    await rename(vault, "Beta.md", "Alpha.md", "first [[tmp]] then [[Alpha]]");
    await rename(vault, "tmp.md", "Beta.md", "first [[Beta]] then [[Alpha]]");
    await settle(vault);
    expect(vault.local.text("Beta.md")).toBe("alpha");
    expect(vault.local.text("Alpha.md")).toBe("beta");
    expect(vault.local.text("Index.md")).toBe("first [[Beta]] then [[Alpha]]");
  }, 60_000);
});
