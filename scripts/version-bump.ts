import manifest from "../manifest.json";
import pkg from "../package.json";
import versions from "../versions.json";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  throw new Error("Usage: bun run version <x.y.z>");
const write = (path: string, value: unknown) =>
  Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
await write("package.json", { ...pkg, version });
await write("manifest.json", { ...manifest, version });
await write("versions.json", {
  ...versions,
  [version]: manifest.minAppVersion,
});
