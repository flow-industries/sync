import { nameOf, parentOf } from "./paths";

const encoder = new TextEncoder();
const MAX_NAME_BYTES = 255;

/**
 * Where a conflicting copy of `path` goes: beside it, named as NOTE names its
 * own conflict copies of notes, `<name> conflict <8 hex>.md`, with the name
 * shortened until it fits 255 bytes. An attachment keeps its extension last
 * too, where NOTE would append the suffix, so Obsidian still opens it.
 */
export function conflictPath(
  path: string,
  id: () => string = () => crypto.randomUUID(),
): string {
  const name = nameOf(path);
  const extension = /(?<=.)\.[^.]+$/u.exec(name)?.[0] ?? "";
  const ending = /^\.mdx?$/iu.test(extension)
    ? extension.toLowerCase()
    : extension;
  const suffix = ` conflict ${id().slice(0, 8)}${ending}`;
  const characters = Array.from(name.slice(0, name.length - extension.length));
  while (
    encoder.encode(`${characters.join("")}${suffix}`).length > MAX_NAME_BYTES
  ) {
    if (!characters.length) throw new Error("Name suffix exceeds bounds");
    characters.pop();
  }
  const parent = parentOf(path);
  const copy = `${characters.join("")}${suffix}`;
  return parent ? `${parent}/${copy}` : copy;
}
