import { describe, expect, test } from "bun:test";
import {
  type Deletions,
  MAX_ATTACHMENT_BYTES,
  SyncEngine,
} from "../src/engine";
import { isStale, MemoryIndex, MemoryRemote, MemoryVault } from "./fakes";

async function setup(
  options: { confirm?: (deletions: Deletions) => Promise<boolean> } = {},
) {
  const local = new MemoryVault();
  const remote = new MemoryRemote();
  const index = new MemoryIndex();
  const asked: Deletions[] = [];
  const engine = new SyncEngine({
    local,
    remote,
    index,
    configDir: ".obsidian",
    stale: isStale,
    confirmDeletions: async (deletions) => {
      asked.push(deletions);
      return (await options.confirm?.(deletions)) ?? true;
    },
  });
  await engine.load();
  return { local, remote, index, engine, asked };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const settled = async ({ engine }: Setup) => {
  const first = await engine.run();
  engine.remoteChanged();
  const second = await engine.run();
  expect(second.applied).toBe(0);
  return first;
};
const remotePaths = (remote: MemoryRemote) =>
  [...remote.items.values()]
    .map((item) => `${item.path}: ${remote.text(item.path)}`)
    .sort();
const localPaths = (local: MemoryVault) =>
  [...local.files.keys()].map((path) => `${path}: ${local.text(path)}`).sort();

describe("engine: a first sync", () => {
  test("pushes local files, pulls remote ones, and leaves config and unstorable names alone", async () => {
    const w = await setup();
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const pdf = new Uint8Array([37, 80, 68, 70, 9]);
    w.local.put("Here.md", "local");
    w.local.put("Dir/Deep.mdx", "<Mdx />");
    w.local.put("Dir/photo.png", png);
    w.local.put("con.md", "a name NOTE refuses");
    w.local.put("huge.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
    w.remote.put("t", "There.md", "remote");
    w.remote.put("p", "Papers/paper.pdf", pdf);
    w.remote.put("hidden", ".obsidian/plugins/x/main.js", "never written");
    const result = await settled(w);
    expect(
      [...w.remote.items.values()].map((item) => item.path).sort(),
    ).toEqual([
      ".obsidian/plugins/x/main.js",
      "Dir/Deep.mdx",
      "Dir/photo.png",
      "Here.md",
      "Papers/paper.pdf",
      "There.md",
    ]);
    expect(w.remote.byPath("Dir/photo.png")?.body).toEqual(png);
    expect([...w.local.files.keys()].sort()).toEqual([
      "Dir/Deep.mdx",
      "Dir/photo.png",
      "Here.md",
      "Papers/paper.pdf",
      "There.md",
      "con.md",
      "huge.bin",
    ]);
    expect(w.local.files.get("Papers/paper.pdf")?.body).toEqual(pdf);
    expect(w.local.text("There.md")).toBe("remote");
    expect(result.unsyncable.sort()).toEqual([
      ".obsidian/plugins/x/main.js",
      "con.md",
      "huge.bin",
    ]);
  });

  test("carries attachment edits, renames and conflicts, keeping the extension last", async () => {
    const w = await setup();
    w.local.put("a.png", new Uint8Array([1]));
    await settled(w);
    w.local.put("a.png", new Uint8Array([2]));
    await settled(w);
    expect(w.remote.byPath("a.png")?.body).toEqual(new Uint8Array([2]));
    const id = w.remote.byPath("a.png")?.id ?? "";
    await w.remote.rename(id, "img/b.png");
    w.engine.remoteChanged();
    await settled(w);
    expect([...w.local.files.keys()]).toEqual(["img/b.png"]);
    w.local.put("img/b.png", new Uint8Array([3]));
    w.remote.put(id, "img/b.png", new Uint8Array([4]));
    w.engine.remoteChanged();
    await settled(w);
    const copy = [...w.local.files.keys()].find((path) => path !== "img/b.png");
    expect(copy).toMatch(/^img\/b conflict [0-9a-f]{8}\.png$/);
    expect(w.local.files.get("img/b.png")?.body).toEqual(new Uint8Array([4]));
    expect(w.local.files.get(copy ?? "")?.body).toEqual(new Uint8Array([3]));
    expect(w.remote.byPath(copy ?? "")?.body).toEqual(new Uint8Array([3]));
  });

  test("a synced attachment that grows past the limit is left alone on both sides", async () => {
    const w = await setup();
    w.local.put("big.bin", new Uint8Array([1]));
    await settled(w);
    w.local.put("big.bin", new Uint8Array(MAX_ATTACHMENT_BYTES + 1));
    const result = await w.engine.run();
    expect(result.unsyncable).toEqual(["big.bin"]);
    expect(w.remote.byPath("big.bin")?.body).toEqual(new Uint8Array([1]));
    expect(w.local.files.has("big.bin")).toBe(true);
  });

  test("an existing note on both sides with different text keeps both", async () => {
    const w = await setup();
    w.local.put("Plan.md", "mine");
    w.remote.put("p", "plan.md", "theirs");
    await settled(w);
    const copy = [...w.local.files.keys()].find((path) =>
      path.includes("conflict"),
    );
    expect(copy).toMatch(/^plan conflict [0-9a-f]{8}\.md$/);
    expect(w.local.text("plan.md")).toBe("theirs");
    expect(w.local.text(copy ?? "")).toBe("mine");
    expect(w.remote.text(copy ?? "")).toBe("mine");
  });
});

describe("engine: after the first sync", () => {
  async function synced() {
    const w = await setup();
    w.local.put("A.md", "one");
    w.remote.put("b", "B.md", "two");
    await settled(w);
    return w;
  }

  test("carries edits both ways on the revision they were made on", async () => {
    const w = await synced();
    w.local.put("A.md", "one, edited here");
    w.remote.put("b", "B.md", "two, edited there");
    w.engine.remoteChanged();
    await settled(w);
    expect(w.remote.text("A.md")).toBe("one, edited here");
    expect(w.local.text("B.md")).toBe("two, edited there");
  });

  test("carries renames both ways", async () => {
    const w = await synced();
    await w.local.move("A.md", "Moved/A2.md");
    w.engine.renamed("A.md", "Moved/A2.md");
    const b = w.remote.byPath("B.md");
    await w.remote.rename(b?.id ?? "", "Elsewhere/B.md");
    w.engine.remoteChanged();
    await settled(w);
    expect(remotePaths(w.remote)).toEqual([
      "Elsewhere/B.md: two",
      "Moved/A2.md: one",
    ]);
    expect(localPaths(w.local)).toEqual([
      "Elsewhere/B.md: two",
      "Moved/A2.md: one",
    ]);
  });

  test("carries a folder rename Obsidian reported once", async () => {
    const w = await setup();
    w.local.put("Old/x.md", "x");
    w.local.put("Old/Sub/y.md", "y");
    await settled(w);
    await w.local.move("Old/x.md", "New/x.md");
    await w.local.move("Old/Sub/y.md", "New/Sub/y.md");
    w.engine.renamed("Old", "New");
    await settled(w);
    expect(remotePaths(w.remote)).toEqual(["New/Sub/y.md: y", "New/x.md: x"]);
  });

  test("a conflict keeps the remote text in place and the local text in a NOTE-style copy", async () => {
    const w = await synced();
    w.local.put("A.md", "local edit");
    const a = w.remote.byPath("A.md");
    w.remote.put(a?.id ?? "", "A.md", "remote edit");
    w.engine.remoteChanged();
    await settled(w);
    expect(w.local.text("A.md")).toBe("remote edit");
    const copy = [...w.local.files.keys()].find((path) =>
      path.startsWith("A conflict "),
    );
    expect(w.local.text(copy ?? "")).toBe("local edit");
    expect(w.remote.text(copy ?? "")).toBe("local edit");
  });

  test("NOTE deleting an empty note deletes it here too, once", async () => {
    const w = await setup();
    w.local.put("Empty.md", "");
    w.local.put("Full.md", "text");
    await settled(w);
    await w.remote.remove(w.remote.byPath("Empty.md")?.id ?? "");
    await w.remote.remove(w.remote.byPath("Full.md")?.id ?? "");
    w.engine.remoteChanged();
    await settled(w);
    expect(w.local.trashed.sort()).toEqual(["Empty.md", "Full.md"]);
  });

  test("deletes both ways, into each side's trash", async () => {
    const w = await synced();
    await w.local.trash("A.md");
    const b = w.remote.byPath("B.md");
    await w.remote.remove(b?.id ?? "");
    w.engine.remoteChanged();
    await settled(w);
    expect(w.remote.items.size).toBe(0);
    expect(w.local.files.size).toBe(0);
    expect(w.local.trashed).toEqual(["A.md", "B.md"]);
  });

  test("never overwrites an edit made while the round runs", async () => {
    const w = await synced();
    w.remote.put("b", "B.md", "remote edit");
    w.engine.remoteChanged();
    w.local.beforeWrite = (path) => {
      if (path === "B.md") w.local.put("B.md", "typed meanwhile");
      w.local.beforeWrite = undefined;
    };
    const result = await w.engine.run();
    expect(result.failed.map((failure) => failure.path)).toEqual(["B.md"]);
    expect(w.local.text("B.md")).toBe("typed meanwhile");
    await settled(w);
    const copy = [...w.local.files.keys()].find((path) =>
      path.startsWith("B conflict "),
    );
    expect(w.local.text("B.md")).toBe("remote edit");
    expect(w.local.text(copy ?? "")).toBe("typed meanwhile");
  });

  test("a NOTE edit that lands between the read and the push becomes a conflict, never overwritten", async () => {
    const w = await synced();
    const a = w.remote.byPath("A.md")?.id ?? "";
    w.local.put("A.md", "local edit");
    w.remote.beforeWrite = (id) => {
      if (id !== a) return;
      w.remote.beforeWrite = undefined;
      w.remote.put(a, "A.md", "remote edit");
    };
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    const copy = [...w.local.files.keys()].find((path) =>
      path.startsWith("A conflict "),
    );
    expect(w.remote.text("A.md")).toBe("remote edit");
    expect(w.local.text("A.md")).toBe("remote edit");
    expect(w.local.text(copy ?? "")).toBe("local edit");
    expect(w.remote.text(copy ?? "")).toBe("local edit");
  });

  test("a NOTE edit that lands before a deletion reaches it comes back instead", async () => {
    const w = await synced();
    const a = w.remote.byPath("A.md")?.id ?? "";
    await w.local.trash("A.md");
    w.remote.beforeWrite = (id) => {
      if (id !== a) return;
      w.remote.beforeWrite = undefined;
      w.remote.put(a, "A.md", "edited there");
    };
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    expect(w.remote.removed).toEqual([]);
    expect(w.remote.text("A.md")).toBe("edited there");
    expect(w.local.text("A.md")).toBe("edited there");
  });

  test("a NOTE edit that lands while a conflict is resolved leaves one copy", async () => {
    const w = await synced();
    const a = w.remote.byPath("A.md")?.id ?? "";
    await w.local.move("A.md", "Moved.md");
    w.engine.renamed("A.md", "Moved.md");
    w.local.put("Moved.md", "local edit");
    w.remote.put(a, "A.md", "remote edit");
    w.engine.remoteChanged();
    w.remote.beforeWrite = (id) => {
      if (id !== a) return;
      w.remote.beforeWrite = undefined;
      w.remote.put(a, "A.md", "remote edit, again");
    };
    await settled(w);
    const copies = [...w.local.files.keys()].filter((path) =>
      path.startsWith("Moved conflict "),
    );
    expect(copies.length).toBe(1);
    expect(w.local.text(copies[0] ?? "")).toBe("local edit");
    expect(w.local.text("Moved.md")).toBe("remote edit, again");
    expect(remotePaths(w.remote)).toEqual([
      "B.md: two",
      `${copies[0]}: local edit`,
      "Moved.md: remote edit, again",
    ]);
  });

  test("resumes from the saved index without redoing anything", async () => {
    const w = await synced();
    const engine = new SyncEngine({
      local: w.local,
      remote: w.remote,
      index: w.index,
      configDir: ".obsidian",
    });
    await engine.load();
    expect((await engine.run()).applied).toBe(0);
  });
});

describe("engine: renames into names other items are leaving", () => {
  async function three() {
    const w = await setup();
    w.local.put("A.md", "a");
    w.local.put("B.md", "b");
    w.local.put("C.md", "c");
    await settled(w);
    return w;
  }
  const moveHere = async (w: Setup, from: string, to: string) => {
    await w.local.move(from, to);
    w.engine.renamed(from, to);
  };
  const parked = (w: Setup) =>
    [
      ...w.local.files.keys(),
      ...[...w.remote.items.values()].map((item) => item.path),
    ].filter((path) => path.includes(" moving "));

  test("two notes swapping names here converge, edits included", async () => {
    const w = await three();
    await moveHere(w, "A.md", "tmp.md");
    await moveHere(w, "B.md", "A.md");
    await moveHere(w, "tmp.md", "B.md");
    w.local.put("B.md", "a, edited after the swap");
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    expect(remotePaths(w.remote)).toEqual([
      "A.md: b",
      "B.md: a, edited after the swap",
      "C.md: c",
    ]);
    expect(parked(w)).toEqual([]);
  });

  test("two notes swapping names in NOTE converge here", async () => {
    const w = await three();
    const a = w.remote.byPath("A.md")?.id ?? "";
    const b = w.remote.byPath("B.md")?.id ?? "";
    await w.remote.rename(a, "tmp.md");
    await w.remote.rename(b, "A.md");
    await w.remote.rename(a, "B.md");
    w.engine.remoteChanged();
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    expect(localPaths(w.local)).toEqual(["A.md: b", "B.md: a", "C.md: c"]);
    expect(parked(w)).toEqual([]);
  });

  test("three notes rotating names converge", async () => {
    const w = await three();
    await moveHere(w, "A.md", "tmp.md");
    await moveHere(w, "C.md", "A.md");
    await moveHere(w, "B.md", "C.md");
    await moveHere(w, "tmp.md", "B.md");
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    expect(remotePaths(w.remote)).toEqual(["A.md: c", "B.md: a", "C.md: b"]);
    expect(parked(w)).toEqual([]);
  });

  for (const side of ["here", "in NOTE"] as const)
    test(`a quit right after a swap ${side} parked one note still ends at the swapped names`, async () => {
      const w = await three();
      const restarted = () =>
        new SyncEngine({
          local: w.local,
          remote: w.remote,
          index: w.index,
          configDir: ".obsidian",
          stale: isStale,
        });
      const quitting = restarted();
      await quitting.load();
      // Obsidian quits the moment one note lands on its temporary name.
      const rename = w.remote.rename.bind(w.remote);
      w.remote.rename = async (id, path, base) => {
        const saved = await rename(id, path, base);
        if (path.includes(" moving ")) quitting.stop();
        return saved;
      };
      const move = w.local.move.bind(w.local);
      w.local.move = async (from, to) => {
        const moved = await move(from, to);
        if (to.includes(" moving ")) quitting.stop();
        return moved;
      };
      if (side === "here") {
        for (const [from, to] of [
          ["A.md", "tmp.md"],
          ["B.md", "A.md"],
          ["tmp.md", "B.md"],
        ] as const) {
          await move(from, to);
          quitting.renamed(from, to);
        }
      } else {
        const a = w.remote.byPath("A.md")?.id ?? "";
        const b = w.remote.byPath("B.md")?.id ?? "";
        await rename(a, "tmp.md");
        await rename(b, "A.md");
        await rename(a, "B.md");
      }
      await quitting.run();
      expect(parked(w).length).toBeGreaterThan(0);
      w.remote.rename = rename;
      w.local.move = move;

      const after = restarted();
      await after.load();
      for (let round = 0; round < 3; round++) {
        after.remoteChanged();
        await after.run();
      }
      expect(localPaths(w.local)).toEqual(["A.md: b", "B.md: a", "C.md: c"]);
      expect(remotePaths(w.remote)).toEqual(["A.md: b", "B.md: a", "C.md: c"]);
    });

  test("a chain of renames goes in order, never through a temporary name", async () => {
    const w = await three();
    await moveHere(w, "C.md", "D.md");
    await moveHere(w, "B.md", "C.md");
    await moveHere(w, "A.md", "B.md");
    const renamed: string[] = [];
    w.remote.beforeWrite = (id) => {
      renamed.push(id);
    };
    const result = await settled(w);
    expect(result.failed).toEqual([]);
    expect(remotePaths(w.remote)).toEqual(["B.md: a", "C.md: b", "D.md: c"]);
    expect(renamed.length).toBe(3);
  });
});

describe("engine: mass deletions", () => {
  async function many(confirm: (deletions: Deletions) => Promise<boolean>) {
    const w = await setup({ confirm });
    for (let n = 0; n < 12; n++) w.remote.put(`n${n}`, `N${n}.md`, `${n}`);
    await settled(w);
    w.remote.items.clear();
    w.engine.remoteChanged();
    return w;
  }

  test("wait for confirmation, and are held when declined", async () => {
    const w = await many(async () => false);
    const result = await w.engine.run();
    expect(w.asked).toEqual([{ local: 12, remote: 0 }]);
    expect(result.held).toEqual({ local: 12, remote: 0 });
    expect(w.local.files.size).toBe(12);
    await w.engine.run();
    expect(w.asked.length).toBe(1);
    w.engine.reconsiderDeletions();
    await w.engine.run();
    expect(w.asked.length).toBe(2);
  });

  test("go ahead once confirmed", async () => {
    const w = await many(async () => true);
    await w.engine.run();
    expect(w.local.files.size).toBe(0);
    expect(w.local.trashed.length).toBe(12);
  });

  test("past fifty, wait for confirmation however large the vault", async () => {
    const w = await setup({ confirm: async () => false });
    for (let n = 0; n < 600; n++) w.remote.put(`n${n}`, `N${n}.md`, `${n}`);
    await settled(w);
    for (let n = 0; n < 51; n++) w.remote.items.delete(`n${n}`);
    w.engine.remoteChanged();
    await w.engine.run();
    expect(w.asked).toEqual([{ local: 51, remote: 0 }]);
    expect(w.local.files.size).toBe(600);
  });
});

describe("engine: collisions", () => {
  test("a file whose name differs only in case from a synced note stays out", async () => {
    const w = await setup();
    w.local.put("Note.md", "original");
    await settled(w);
    w.local.put("note.md", "a different note");
    const result = await w.engine.run();
    expect(result.unsyncable).toEqual(["note.md"]);
    expect(remotePaths(w.remote)).toEqual(["Note.md: original"]);
  });

  test("a new file where a remote rename is headed steps aside as a conflict copy", async () => {
    const w = await setup();
    w.local.put("A.md", "a");
    await settled(w);
    const a = w.remote.byPath("A.md");
    await w.remote.rename(a?.id ?? "", "B.md");
    w.local.put("B.md", "unrelated");
    w.engine.remoteChanged();
    await settled(w);
    const aside = [...w.local.files.keys()].find((path) =>
      path.startsWith("B conflict "),
    );
    expect(w.local.text("B.md")).toBe("a");
    expect(w.local.text(aside ?? "")).toBe("unrelated");
    expect(remotePaths(w.remote)).toEqual([`${aside}: unrelated`, "B.md: a"]);
  });

  test("deleting B, then renaming A to B, trashes B in NOTE and moves A there", async () => {
    const w = await setup();
    w.local.put("A.md", "a");
    w.local.put("B.md", "b");
    await settled(w);
    await w.local.trash("B.md");
    await w.local.move("A.md", "B.md");
    w.engine.renamed("A.md", "B.md");
    await settled(w);
    expect(remotePaths(w.remote)).toEqual(["B.md: a"]);
  });

  test("a move that succeeds before its write fails is remembered", async () => {
    const w = await setup();
    w.local.put("A.md", "a");
    await settled(w);
    const a = w.remote.byPath("A.md");
    await w.remote.rename(a?.id ?? "", "B.md");
    w.remote.put(a?.id ?? "", "B.md", "edited there");
    w.engine.remoteChanged();
    w.local.beforeWrite = (path) => {
      if (path === "B.md") w.local.put("B.md", "typed here");
      w.local.beforeWrite = undefined;
    };
    await w.engine.run();
    await settled(w);
    const copy = [...w.local.files.keys()].find((path) =>
      path.startsWith("B conflict "),
    );
    expect(w.local.text("B.md")).toBe("edited there");
    expect(w.local.text(copy ?? "")).toBe("typed here");
  });

  test("a stopped engine writes nothing more", async () => {
    const w = await setup();
    w.remote.put("a", "A.md", "a");
    w.remote.put("b", "B.md", "b");
    w.local.beforeWrite = () => w.engine.stop();
    await w.engine.run();
    expect(w.local.files.size).toBeLessThanOrEqual(1);
    w.local.beforeWrite = undefined;
    await w.engine.run();
    expect(w.local.files.size).toBeLessThanOrEqual(1);
  });
});
