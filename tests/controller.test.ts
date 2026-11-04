import { describe, expect, test } from "bun:test";
import type { SyncListener } from "@flow-industries/seal";
import {
  type ControllerOptions,
  KEY_MISSING,
  LOCKED_ELSEWHERE,
  REMOVED,
  STRANDED,
  SyncController,
} from "../src/controller";
import { Custody, type SecretBackend } from "../src/custody";
import type { DeviceOptions, DeviceVault } from "../src/device";
import { sha256 } from "../src/hash";
import { isStale, MemoryIndex, MemoryRemote, MemoryVault } from "./fakes";

class Secrets implements SecretBackend {
  values = new Map<string, string>();
  get = (id: string) => this.values.get(id) ?? null;
  set = (id: string, value: string) => void this.values.set(id, value);
  delete = (id: string) => void this.values.delete(id);
}
const did = "did:plc:abcdefghijklmnopqrstuvwx";
const credentials = {
  accessToken: "fnd_a",
  refreshToken: "fndr_r",
  deviceId: "device",
  userId: "owner",
  did,
  accessExpiresAt: 1,
};
const checkpoint = {
  vault: "vault",
  epoch: 1,
  pinned: { statement: "s", sequence: 1, admins: ["a"], recipients: ["a"] },
  trust: "handed" as const,
  runners: [],
};

/** A device vault over `MemoryRemote` whose sync reports `SYNCED` once `pull` lets it. */
function deviceVault(remote: MemoryRemote, stranded = false) {
  const listeners = new Set<SyncListener>();
  const state = { stopped: false, pull: true };
  const vault = {
    read: () => remote.read().then((view) => ({ ...view, folders: [] })),
    saveNote: (note, options) => remote.saveNote(note, options),
    listAttachments: async () =>
      (await remote.listAttachments()).map((item) => ({
        ...item,
        mime: "application/octet-stream",
        size: 0,
      })),
    readAttachment: (id) => remote.readAttachment(id),
    saveAttachment: (attachment, options) =>
      remote.saveAttachment(attachment, options),
    rename: (id, path, base) => remote.rename(id, path, base),
    remove: (id, base) => remote.remove(id, base),
    compose: async () => ({ selectedId: "" }),
    sync: async () => {
      if (state.pull)
        for (const listener of listeners) await listener("Synced");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeChanges: () => () => {},
    subscribeTrustLoss: () => () => {},
    stop: () => {
      state.stopped = true;
    },
    ...(stranded && {
      stranded: { count: 1, download: async () => new Blob() },
    }),
  } as DeviceVault;
  return { vault, state };
}

async function harness(
  options: {
    opened?: Promise<void>;
    stranded?: boolean;
    held?: boolean;
    confirmed?: boolean;
    fetch?: ControllerOptions["fetch"];
    hold?: ControllerOptions["hold"];
    onOpen?: (options: DeviceOptions) => void;
  } = {},
) {
  const secrets = new Secrets();
  const custody = new Custody(secrets, "0123456789abcdef");
  custody.saveSeed(new Uint8Array(32).fill(1));
  await custody.credentials.write(credentials);
  await custody.checkpoints.write(checkpoint);
  if (options.confirmed ?? true) custody.confirmAccount({ did });
  const local = new MemoryVault();
  const remote = new MemoryRemote();
  const index = new MemoryIndex();
  const device = deviceVault(remote, options.stranded);
  const forgotten: string[] = [];
  const notices: string[] = [];
  const controllerOptions: ControllerOptions = {
    custody,
    device: {
      createDeviceSeed: () => new Uint8Array(32).fill(2),
      linkDevice: () => new Promise(() => {}),
      openDeviceVault: async (_seed, deviceOptions) => {
        await options.opened;
        options.onOpen?.(deviceOptions);
        return device.vault;
      },
      locked: "Locked",
      pulled: (status) => status === "Synced",
      stale: isStale,
    },
    host: "https://id.example",
    fetch: options.fetch ?? (async () => new Response(null, { status: 404 })),
    local,
    configDir: ".obsidian",
    indexFor: () => index,
    forgetIndexes: async () => index.clear(),
    hold: options.hold ?? (async () => (options.held ? null : () => {})),
    forgetDevice: async (seed) => {
      forgotten.push(`seed ${seed[0]}`);
    },
    confirmDeletions: async () => true,
    onChange: () => {},
    onTrustLoss: () => {},
    notify: (message) => notices.push(message),
  };
  const controller = new SyncController(controllerOptions);
  return {
    controller,
    custody,
    secrets,
    local,
    remote,
    index,
    device,
    forgotten,
    notices,
  };
}

describe("controller", () => {
  test("syncs only after the device has read the vault since it opened", async () => {
    const h = await harness();
    h.device.state.pull = false;
    h.local.put("Here.md", "local");
    await h.controller.start();
    await h.controller.syncNow();
    expect(h.remote.items.size).toBe(0);
    h.device.state.pull = true;
    await h.controller.syncNow();
    expect(h.remote.text("Here.md")).toBe("local");
    h.controller.close();
  });

  test("an unconfirmed link stays unconfirmed across a restart", async () => {
    const h = await harness({ confirmed: false });
    h.local.put("Here.md", "local");
    await h.controller.start();
    expect(h.controller.phase.kind).toBe("confirm");
    await h.controller.syncNow();
    expect(h.remote.items.size).toBe(0);
  });

  test("a vault closed or unlinked while it opens never opens", async () => {
    for (const interrupt of ["close", "unlink"] as const) {
      const opened = Promise.withResolvers<void>();
      const h = await harness({ opened: opened.promise });
      h.local.put("Here.md", "local");
      const starting = h.controller.start();
      await Bun.sleep(0);
      if (interrupt === "close") h.controller.close();
      else await h.controller.unlink();
      opened.resolve();
      await starting;
      await Bun.sleep(5);
      expect(h.controller.phase.kind).not.toBe("open");
      expect(h.device.state.stopped).toBe(true);
      expect(h.remote.items.size).toBe(0);
      if (interrupt === "unlink") {
        expect(h.controller.phase.kind).toBe("unlinked");
        expect(h.custody.seed()).toBeNull();
      }
    }
  });

  test("a link started over a stored link is refused, and the stored link stays", async () => {
    const h = await harness({ confirmed: false });
    const restarting = h.controller.start();
    const linking = h.controller
      .link("Obsidian", new AbortController().signal)
      .then(
        () => "linked",
        (error: Error) => error.message,
      );
    await restarting;
    expect(
      await Promise.race([linking, Bun.sleep(500).then(() => "linking")]),
    ).toMatch(/still linked/u);
    expect(h.controller.phase.kind).toBe("confirm");
    expect(h.custody.seed()).not.toBeNull();
    expect(h.forgotten).toEqual([]);
  });

  test("a second window of the same vault doesn't open a second transport", async () => {
    const h = await harness({ held: true });
    await h.controller.start();
    expect(h.controller.phase).toEqual({
      kind: "stopped",
      message: LOCKED_ELSEWHERE,
    });
    expect(h.device.state.stopped).toBe(false);
  });

  test("unlinking forgets the device's databases, by its seed, and the sync index", async () => {
    const h = await harness();
    await h.controller.start();
    await h.controller.syncNow();
    h.index.entries = [
      {
        id: "a",
        path: "A.md",
        revision: "r",
        digest: "d",
        hash: "h",
        mtime: 1,
        size: 1,
      },
    ];
    await h.controller.unlink();
    expect(h.forgotten).toEqual(["seed 1"]);
    expect(h.index.entries).toEqual([]);
    expect(h.secrets.values.has("flow-note-0123456789abcdef-tokens")).toBe(
      false,
    );
  });

  test("edits a key rotation stranded are kept as conflict copies, not overwritten", async () => {
    const h = await harness({ stranded: true });
    const edit = "edit the rotation stranded";
    h.local.put("A.md", edit);
    h.remote.put("a", "A.md", "NOTE's older text");
    // The index counts the edit as synced: it reached the device's outbox before the rotation.
    const [file] = await h.local.list();
    h.index.entries = [
      {
        id: "a",
        path: "A.md",
        revision: "gone",
        digest: "gone",
        hash: await sha256(edit),
        mtime: file?.mtime ?? 0,
        size: file?.size ?? 0,
      },
    ];
    await h.controller.start();
    await h.controller.syncNow();
    expect(h.notices).toEqual([STRANDED]);
    expect(h.local.text("A.md")).toBe("NOTE's older text");
    const copy = [...h.local.files.keys()].find((path) =>
      path.startsWith("A conflict "),
    );
    expect(h.local.text(copy ?? "")).toBe("edit the rotation stranded");
    h.controller.close();
  });

  test("a link whose key went missing stops with Unlink as the way out", async () => {
    const h = await harness({ confirmed: false });
    h.secrets.values.delete("flow-note-0123456789abcdef-seed");
    await h.controller.start();
    expect(h.controller.phase).toEqual({
      kind: "stopped",
      message: KEY_MISSING,
    });
    expect(h.controller.stored()).toBe(true);
    await h.controller.unlink();
    expect(h.controller.phase.kind).toBe("unlinked");
    expect(h.controller.stored()).toBe(false);
  });

  test("a stop or a removal is told once in a notice, since mobile has no status bar", async () => {
    const h = await harness({ held: true });
    await h.controller.start();
    await h.controller.syncNow();
    expect(h.notices).toEqual([`Syncing stopped. ${LOCKED_ELSEWHERE}`]);

    let removed: DeviceOptions["onRemoved"];
    const r = await harness({
      onOpen: (options) => {
        removed = (reason) => options.onRemoved?.(reason) ?? Promise.resolve();
      },
    });
    await r.controller.start();
    await removed?.("removed");
    expect(r.controller.phase.kind).toBe("removed");
    expect(r.notices).toEqual([REMOVED.removed]);
  });

  test("a reopen waits for a token refresh the closed device already sent", async () => {
    const refresh = Promise.withResolvers<Response>();
    let opens = 0;
    let held = false;
    const h = await harness({
      fetch: () => refresh.promise,
      hold: async () => {
        if (held) return null;
        held = true;
        return () => {
          held = false;
        };
      },
      onOpen: (options) => {
        if (++opens === 1)
          void options.fetch?.("https://id.example/refresh", {
            method: "POST",
          });
      },
    });
    await h.controller.start();
    h.controller.close();
    const reopening = h.controller.start();
    await Bun.sleep(100);
    expect(opens).toBe(1);
    expect(h.controller.phase.kind).not.toBe("stopped");
    refresh.resolve(new Response("{}"));
    await reopening;
    expect(opens).toBe(2);
    expect(h.controller.phase.kind).toBe("open");
    h.controller.close();
  });
});

/** A device vault over `remote`; `beforeSave` can hold a save open mid-round. */
function deviceOver(
  remote: MemoryRemote,
  hooks: { beforeSave?: () => Promise<void> } = {},
) {
  const listeners = new Set<SyncListener>();
  return {
    read: () => remote.read().then((view) => ({ ...view, folders: [] })),
    saveNote: async (note, options) => {
      await hooks.beforeSave?.();
      return remote.saveNote(note, options);
    },
    listAttachments: async () =>
      (await remote.listAttachments()).map((item) => ({
        ...item,
        mime: "application/octet-stream",
        size: 0,
      })),
    readAttachment: (id) => remote.readAttachment(id),
    saveAttachment: (attachment, options) =>
      remote.saveAttachment(attachment, options),
    rename: (id, path, base) => remote.rename(id, path, base),
    remove: (id, base) => remote.remove(id, base),
    compose: async () => ({ selectedId: "" }),
    sync: async () => {
      for (const listener of listeners) await listener("Synced");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeChanges: () => () => {},
    subscribeTrustLoss: () => () => {},
    stop: () => {},
  } as DeviceVault;
}

/**
 * A linked, confirmed vault whose opens answer from `opens` in turn, and
 * whose next link is device 2. Indexes are named by whatever the controller
 * passes, as the plugin names their databases.
 */
function linkedVault(local: MemoryVault, opens: (() => DeviceVault)[]) {
  const secrets = new Secrets();
  const custody = new Custody(secrets, "0123456789abcdef");
  const credentialsOf = (deviceId: string) => ({ ...credentials, deviceId });
  custody.saveSeed(new Uint8Array(32).fill(1));
  void custody.credentials.write(credentialsOf("device-1"));
  void custody.checkpoints.write(checkpoint);
  custody.confirmAccount({ did });
  const indexes = new Map<string, MemoryIndex>();
  const controller = new SyncController({
    custody,
    device: {
      createDeviceSeed: () => new Uint8Array(32).fill(2),
      linkDevice: async (_seed, options) => {
        await options.credentials.write(credentialsOf("device-2"));
        await options.checkpoints.write(checkpoint);
        return checkpoint;
      },
      openDeviceVault: async () => {
        const open = opens.shift();
        if (!open) throw new Error("No more opens");
        return open();
      },
      locked: "Locked",
      pulled: (status) => status === "Synced",
      stale: isStale,
    },
    host: "https://id.example",
    fetch: async () => new Response(null, { status: 404 }),
    local,
    configDir: ".obsidian",
    indexFor: (...key: unknown[]) => {
      const name = JSON.stringify(key);
      const index = indexes.get(name) ?? new MemoryIndex();
      indexes.set(name, index);
      return index;
    },
    forgetIndexes: async () => indexes.clear(),
    hold: async () => () => {},
    forgetDevice: async () => {},
    confirmDeletions: async () => true,
    onChange: () => {},
    onTrustLoss: () => {},
    notify: () => {},
  });
  return { controller, secrets, indexes };
}

describe("controller: linking again", () => {
  for (const way of ["over a stopped link", "after the secrets were lost"])
    test(`${way} never plans against the old device's index, so edits that never left it survive`, async () => {
      const local = new MemoryVault();
      // NOTE on the PDS, and device 1's own database, whose writes never got uploaded.
      const server = new MemoryRemote();
      const outbox = new MemoryRemote();
      server.put("a", "A.md", "v1");
      outbox.put("a", "A.md", "v1");
      local.put("A.md", "v1");
      const offline = () => {
        throw new Error("Failed to fetch");
      };
      const { controller, secrets } = linkedVault(
        local,
        way === "over a stopped link"
          ? [() => deviceOver(outbox), offline, () => deviceOver(server)]
          : [() => deviceOver(outbox), () => deviceOver(server)],
      );
      await controller.start();
      await controller.syncNow();
      local.put("A.md", "v2, typed offline");
      local.put("New.md", "a new note, typed offline");
      await controller.syncNow();
      expect(outbox.text("A.md")).toBe("v2, typed offline");
      expect(server.text("A.md")).toBe("v1");
      controller.close();

      if (way === "over a stopped link") {
        await controller.start();
        expect(controller.phase.kind).toBe("stopped");
      } else {
        secrets.values.clear();
        await controller.start();
        expect(controller.phase.kind).toBe("unlinked");
      }
      const signal = new AbortController().signal;
      // Settings offer only Retry and Unlink on a stopped link; the person unlinks, then links.
      await controller
        .link("Obsidian", signal)
        .catch(() =>
          controller.unlink().then(() => controller.link("Obsidian", signal)),
        );
      await controller.confirm();
      await controller.syncNow();
      await Bun.sleep(5);
      controller.close();

      const texts = [...local.files.keys()].map((path) => local.text(path));
      expect(texts).toContain("v2, typed offline");
      expect(texts).toContain("a new note, typed offline");
      expect(local.trashed).toEqual([]);
      expect(server.text("New.md")).toBe("a new note, typed offline");
    });

  test("an unlink during a round's write leaves no sync index behind", async () => {
    const local = new MemoryVault();
    const remote = new MemoryRemote();
    let release = () => {};
    let blocked = false;
    const { controller, indexes } = linkedVault(local, [
      () =>
        deviceOver(remote, {
          beforeSave: () =>
            blocked
              ? new Promise<void>((resolve) => {
                  release = resolve;
                })
              : Promise.resolve(),
        }),
    ]);
    local.put("Old.md", "synced before");
    await controller.start();
    await controller.syncNow();
    expect(indexes.size).toBe(1);
    local.put("A.md", "a");
    blocked = true;
    const syncing = controller.syncNow();
    await Bun.sleep(5);
    await controller.unlink();
    release();
    await syncing;
    await Bun.sleep(5);
    expect(controller.phase.kind).toBe("unlinked");
    expect([...indexes.values()].flatMap((index) => index.entries)).toEqual([]);
  });
});
