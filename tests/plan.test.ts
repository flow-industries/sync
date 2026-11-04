import { describe, expect, test } from "bun:test";
import {
  type Entry,
  type LocalNote,
  plan,
  type RemoteNote,
  type Step,
} from "../src/plan";

const entry = (
  id: string,
  path: string,
  hash: string,
  extra: Partial<Entry> = {},
): Entry => ({
  id,
  path,
  revision: `rev-${hash}`,
  digest: `digest-${hash}`,
  hash,
  mtime: 1,
  size: 1,
  ...extra,
});
const local = (path: string, hash: string): LocalNote => ({
  path,
  hash,
  source: `text ${hash}`,
});
const remote = (id: string, path: string, hash: string): RemoteNote => ({
  id,
  path,
  hash,
  source: `text ${hash}`,
  revision: `rev-${hash}`,
  digest: `digest-${hash}`,
});
let counter = 0;
const newId = () => `0000000${++counter}-new`;
const run = (input: Omit<Parameters<typeof plan>[0], "newId">) => {
  counter = 0;
  return plan({ ...input, newId });
};
const summary = (steps: Step[]) =>
  steps.map((step) =>
    step.kind === "update"
      ? `${step.kind} ${step.id} ${step.path} ${step.content}${step.copy ? ` copy ${step.copy}` : ""}`
      : `${step.kind} ${step.id}`,
  );

describe("plan: one note's change on one side", () => {
  const base = [entry("a", "A.md", "1")];

  test("nothing changed: nothing to do", () => {
    expect(
      run({
        entries: base,
        local: [local("A.md", "1")],
        remote: [remote("a", "A.md", "1")],
      }),
    ).toEqual([]);
  });

  test("a local edit pushes on the revision it was made on", () => {
    const steps = run({
      entries: base,
      local: [local("A.md", "2")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a A.md local"]);
    const [step] = steps;
    expect(step?.kind === "update" && step.remote?.revision).toBe("rev-1");
  });

  test("a remote edit pulls", () => {
    expect(
      summary(
        run({
          entries: base,
          local: [local("A.md", "1")],
          remote: [remote("a", "A.md", "2")],
        }),
      ),
    ).toEqual(["update a A.md remote"]);
  });

  test("a new revision with the same text only moves the index forward", () => {
    const steps = run({
      entries: [entry("a", "A.md", "1", { revision: "" })],
      local: [local("A.md", "1")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a A.md same"]);
  });

  test("a local delete trashes the note in NOTE; a remote delete trashes the file", () => {
    expect(
      summary(
        run({ entries: base, local: [], remote: [remote("a", "A.md", "1")] }),
      ),
    ).toEqual(["delete-remote a"]);
    expect(
      summary(run({ entries: base, local: [local("A.md", "1")], remote: [] })),
    ).toEqual(["delete-local a"]);
    expect(summary(run({ entries: base, local: [], remote: [] }))).toEqual([
      "forget a",
    ]);
  });

  test("an edit beats a delete on the other side", () => {
    expect(
      summary(
        run({ entries: base, local: [], remote: [remote("a", "A.md", "2")] }),
      ),
    ).toEqual(["update a A.md remote"]);
    expect(
      summary(run({ entries: base, local: [local("A.md", "2")], remote: [] })),
    ).toEqual(["update 00000001-new A.md local", "forget a"]);
  });
});

describe("plan: renames", () => {
  const base = [entry("a", "A.md", "1")];

  test("a local rename Obsidian reported renames the note in NOTE", () => {
    const steps = run({
      entries: [entry("a", "A.md", "1", { moved: "Dir/B.md" })],
      local: [local("Dir/B.md", "1")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a Dir/B.md same"]);
  });

  test("a rename made while sync wasn't watching is found by its unchanged text", () => {
    const steps = run({
      entries: base,
      local: [local("B.md", "1")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a B.md same"]);
  });

  test("two files with the same text aren't guessed as the rename", () => {
    const steps = run({
      entries: base,
      local: [local("B.md", "1"), local("C.md", "1")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual([
      "delete-remote a",
      "update 00000001-new B.md local",
      "update 00000002-new C.md local",
    ]);
  });

  test("a remote rename moves the file, keeping a local edit", () => {
    const steps = run({
      entries: base,
      local: [local("A.md", "2")],
      remote: [remote("a", "B.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a B.md local"]);
  });

  test("when both sides renamed, the remote name wins", () => {
    const steps = run({
      entries: [entry("a", "A.md", "1", { moved: "Local.md" })],
      local: [local("Local.md", "1")],
      remote: [remote("a", "Remote.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a Remote.md same"]);
  });

  test("a case-only rename is still a rename", () => {
    const steps = run({
      entries: [entry("a", "A.md", "1", { moved: "a.md" })],
      local: [local("a.md", "1")],
      remote: [remote("a", "A.md", "1")],
    });
    expect(summary(steps)).toEqual(["update a a.md same"]);
  });
});

describe("plan: conflicts", () => {
  test("both sides edited: the remote text keeps the path, the local text becomes a conflict copy", () => {
    const steps = run({
      entries: [entry("a", "Dir/A.md", "1")],
      local: [local("Dir/A.md", "2")],
      remote: [remote("a", "Dir/A.md", "3")],
    });
    expect(summary(steps)).toEqual([
      "update a Dir/A.md remote copy Dir/A conflict 00000001.md",
    ]);
  });

  test("both sides made the same edit: no conflict", () => {
    const steps = run({
      entries: [entry("a", "A.md", "1")],
      local: [local("A.md", "2")],
      remote: [remote("a", "A.md", "2")],
    });
    expect(summary(steps)).toEqual(["update a A.md same"]);
  });

  test("a first sync binds identical notes and keeps both texts of different ones", () => {
    const steps = run({
      entries: [],
      local: [
        local("Same.md", "1"),
        local("Differs.md", "2"),
        local("OnlyHere.md", "4"),
      ],
      remote: [
        remote("s", "Same.md", "1"),
        remote("d", "differs.md", "3"),
        remote("t", "OnlyThere.md", "5"),
      ],
    });
    expect(summary(steps)).toEqual([
      "update 00000002-new OnlyHere.md local",
      "update s Same.md same",
      "update d differs.md remote copy differs conflict 00000001.md",
      "update t OnlyThere.md remote",
    ]);
  });
});

describe("plan: order", () => {
  test("remote deletes free paths before creates, and local edits land before remote renames", () => {
    const steps = run({
      entries: [
        entry("gone", "Old.md", "1"),
        entry("edit", "E.md", "1"),
        entry("move", "M.md", "1", { moved: "N.md" }),
      ],
      local: [local("E.md", "2"), local("N.md", "1"), local("New.md", "9")],
      remote: [
        remote("gone", "Old.md", "1"),
        remote("edit", "E.md", "1"),
        remote("move", "M.md", "1"),
        remote("pull", "P.md", "7"),
      ],
    });
    expect(
      summary(
        steps.filter(
          (step) => step.kind !== "delete-remote" || step.id === "gone",
        ),
      ),
    ).toEqual([
      "delete-remote gone",
      "update edit E.md local",
      "update move N.md same",
      "update 00000001-new New.md local",
      "update pull P.md remote",
    ]);
  });
});
