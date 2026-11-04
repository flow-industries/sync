import { describe, expect, test } from "bun:test";
import { conflictPath } from "../src/conflicts";
import { exclusion, isNotePath, pathKey } from "../src/paths";

describe("which files sync", () => {
  test("Markdown and MDX are notes; everything else is an attachment", () => {
    expect(isNotePath("a/b.md")).toBe(true);
    expect(isNotePath("Plan.MDX")).toBe(true);
    expect(isNotePath("photo.png")).toBe(false);
    expect(isNotePath("notes.md.bak")).toBe(false);
  });

  test("Obsidian's config folder and hidden paths never sync, whatever the case", () => {
    expect(exclusion(".obsidian/app.json", ".obsidian")).toBe("config");
    expect(exclusion(".Obsidian/plugins/x/main.md", ".obsidian")).toBe(
      "config",
    );
    expect(exclusion("config/workspace.md", "config/")).toBe("config");
    expect(exclusion(".trash/old.md", ".obsidian")).toBe("hidden");
    expect(exclusion("a/.git/HEAD.md", ".obsidian")).toBe("hidden");
    expect(exclusion("Projects/Plan.md", ".obsidian")).toBeNull();
  });

  test("scripts other plugins run never sync", () => {
    for (const path of [
      "views/table.js",
      "Scripts/macro.MJS",
      "lib.cjs",
      "a.jsx",
      "tool.py",
      "run.sh",
    ])
      expect(exclusion(path, ".obsidian")).toBe("script");
    expect(exclusion("notes/json.md", ".obsidian")).toBeNull();
    expect(exclusion("data.json", ".obsidian")).toBeNull();
  });

  test("names NOTE can't store stay out, as NOTE's own path rules decide", () => {
    expect(exclusion("a/../b.md", ".obsidian")).not.toBeNull();
    for (const path of [
      "trailing./x.md",
      "space /x.md",
      "con.md",
      "LPT1/x.md",
      "C:drive.md",
      "what?.md",
      `${"x".repeat(256)}.md`,
      "tab\there.md",
    ])
      expect(exclusion(path, ".obsidian")).toBe("unsafe-name");
    expect(exclusion(`${"d/".repeat(64)}x.md`, ".obsidian")).toBe(
      "unsafe-name",
    );
    expect(exclusion("Ünïcode/Notiz.md", ".obsidian")).toBeNull();
  });

  test("paths compare as NOTE compares them: case-insensitive, Unicode-normalized", () => {
    expect(pathKey("Folder/Note.md")).toBe(pathKey("folder/note.MD"));
    expect(pathKey("Café.md")).toBe(pathKey("Café.md"));
    expect(pathKey("a.md")).not.toBe(pathKey("b.md"));
  });
});

describe("conflict copies", () => {
  const id = () => "0123abcd-0000-4000-8000-000000000000";

  test("sit beside the note, named as NOTE names its own", () => {
    expect(conflictPath("Projects/Plan.md", id)).toBe(
      "Projects/Plan conflict 0123abcd.md",
    );
    expect(conflictPath("Top.MDX", id)).toBe("Top conflict 0123abcd.mdx");
  });

  test("keep only a real extension last", () => {
    expect(conflictPath("img/a.b.png", id)).toBe(
      "img/a.b conflict 0123abcd.png",
    );
    expect(conflictPath("Makefile", id)).toBe("Makefile conflict 0123abcd");
    expect(conflictPath("trailing.", id)).toBe("trailing. conflict 0123abcd");
  });

  test("shorten the name to fit NOTE's 255-byte limit", () => {
    const long = `${"é".repeat(200)}.md`;
    const copy = conflictPath(`dir/${long}`, id);
    const name = copy.slice("dir/".length);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith(" conflict 0123abcd.md")).toBe(true);
    expect(exclusion(copy, ".obsidian")).toBeNull();
  });
});
