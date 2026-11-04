import { describe, expect, test } from "bun:test";
import { type Deletions, SyncEngine } from "../src/engine";
import { MemoryIndex, MemoryRemote, MemoryVault } from "./fakes";

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
  [...remote.notes.values()]
    .map((note) => `${note.path}: ${note.source}`)
    .sort();
const localPaths = (local: MemoryVault) =>
  [...local.files].map(([path, file]) => `${path}: ${file.source}`).sort();

describe("engine: a first sync", () => {
  test("pushes local notes, pulls remote ones, and leaves attachments and config alone", async () => {
    const w = await setup();
    w.local.put("Here.md", "local");
    w.local.put("Dir/Deep.mdx", "<Mdx />");
    w.local.put("photo.png", "binary");
    w.local.put("con.md", "a name NOTE refuses");
    w.remote.put("t", "There.md", "remote");
    w.remote.put("hidden", ".obsidian/plugins/x/main.md", "never written");
    const result = await settled(w);
    expect(remotePaths(w.remote)).toEqual([
      ".obsidian/plugins/x/main.md: never written",
      "Dir/Deep.mdx: <Mdx />",
      "Here.md: local",
      "There.md: remote",
    ]);
    expect(localPaths(w.local)).toEqual([
      "Dir/Deep.mdx: <Mdx />",
      "Here.md: local",
      "There.md: remote",
      "con.md: a name NOTE refuses",
      "photo.png: binary",
    ]);
    expect(result.attachments).toBe(1);
    expect(result.unsyncable.sort()).toEqual([
      ".obsidian/plugins/x/main.md",
      "con.md",
    ]);
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
    expect(w.remote.byPath(copy ?? "")?.source).toBe("mine");
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
    expect(w.remote.byPath("A.md")?.source).toBe("one, edited here");
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
    expect(w.remote.byPath(copy ?? "")?.source).toBe("local edit");
  });

  test("deletes both ways, into each side's trash", async () => {
    const w = await synced();
    await w.local.trash("A.md");
    const b = w.remote.byPath("B.md");
    await w.remote.remove(b?.id ?? "");
    w.engine.remoteChanged();
    await settled(w);
    expect(w.remote.notes.size).toBe(0);
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

describe("engine: mass deletions", () => {
  async function many(confirm: (deletions: Deletions) => Promise<boolean>) {
    const w = await setup({ confirm });
    for (let n = 0; n < 12; n++) w.remote.put(`n${n}`, `N${n}.md`, `${n}`);
    await settled(w);
    w.remote.notes.clear();
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
