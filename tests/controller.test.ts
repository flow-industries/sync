import { describe, expect, test } from "bun:test";
import type { SyncListener } from "@flow-industries/seal";
import {
  type ControllerOptions,
  LOCKED_ELSEWHERE,
  STRANDED,
  SyncController,
} from "../src/controller";
import { Custody, type SecretBackend } from "../src/custody";
import type { DeviceVault } from "../src/device";
import { sha256 } from "../src/hash";
import { MemoryIndex, MemoryRemote, MemoryVault } from "./fakes";

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
    saveNote: (note) => remote.saveNote(note),
    rename: (id, path) => remote.rename(id, path),
    remove: (id) => remote.remove(id),
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
      openDeviceVault: async () => {
        await options.opened;
        return device.vault;
      },
      locked: "Locked",
      pulled: (status) => status === "Synced",
    },
    host: "https://id.example",
    fetch: async () => new Response(null, { status: 404 }),
    local,
    configDir: ".obsidian",
    indexFor: () => index,
    hold: async () => (options.held ? null : () => {}),
    forgetLocalDatabase: async (owner, vault) => {
      forgotten.push(`${owner}:${vault}`);
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
    expect(h.remote.notes.size).toBe(0);
    h.device.state.pull = true;
    await h.controller.syncNow();
    expect(h.remote.byPath("Here.md")?.source).toBe("local");
    h.controller.close();
  });

  test("an unconfirmed link stays unconfirmed across a restart", async () => {
    const h = await harness({ confirmed: false });
    h.local.put("Here.md", "local");
    await h.controller.start();
    expect(h.controller.phase.kind).toBe("confirm");
    await h.controller.syncNow();
    expect(h.remote.notes.size).toBe(0);
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
      expect(h.remote.notes.size).toBe(0);
      if (interrupt === "unlink") {
        expect(h.controller.phase.kind).toBe("unlinked");
        expect(h.custody.seed()).toBeNull();
      }
    }
  });

  test("a link started while a restart names the old account wins", async () => {
    const h = await harness({ confirmed: false });
    const restarting = h.controller.start();
    void h.controller.link("Obsidian", new AbortController().signal);
    await restarting;
    expect(h.controller.phase.kind).toBe("linking");
  });

  test("another vault syncing the same account stops this one, and keeps its database on unlink", async () => {
    const h = await harness({ held: true });
    await h.controller.start();
    expect(h.controller.phase).toEqual({
      kind: "stopped",
      message: LOCKED_ELSEWHERE,
    });
    await h.controller.unlink();
    expect(h.forgotten).toEqual([]);
    expect(h.custody.seed()).toBeNull();
  });

  test("unlinking forgets the device's database and the sync index", async () => {
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
    expect(h.forgotten).toEqual([`${did}:vault`]);
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
});
