import { expect, test } from "bun:test";
import manifest from "../manifest.json";
import pkg from "../package.json";
import versions from "../versions.json";

test("the manifest follows Obsidian's directory rules", () => {
  expect(manifest.id).toBe("flow-note");
  expect(manifest.id).not.toMatch(/obsidian|plugin$/i);
  expect(manifest.name).toBe("FLOW NOTE Sync");
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.version).toBe(pkg.version);
  expect(manifest.description.length).toBeLessThanOrEqual(250);
  expect(manifest.description).toMatch(/\.$/);
  expect(manifest.description).not.toMatch(/^This is a plugin/i);
  expect(manifest).not.toHaveProperty("fundingUrl");
});

test("versions.json maps this version to the manifest's minimum app version", () => {
  expect(Object.entries(versions)).toContainEqual([
    manifest.version,
    manifest.minAppVersion,
  ]);
});
