import { nameOf, parentOf } from "./paths";

const encoder = new TextEncoder();
const MAX_NAME_BYTES = 255;

/**
 * `path` renamed beside itself, `<name> <label> <8 hex>.md`, with the name
 * shortened until it fits 255 bytes. An attachment keeps its extension
 * last, so Obsidian still opens it.
 */
function besidePath(path: string, label: string, id: () => string): string {
  const name = nameOf(path);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot) : "";
  const ending = /^\.mdx?$/iu.test(extension)
    ? extension.toLowerCase()
    : extension;
  const suffix = ` ${label} ${id().slice(0, 8)}${ending}`;
  const characters = Array.from(name.slice(0, name.length - extension.length));
  while (
    encoder.encode(`${characters.join("")}${suffix}`).length > MAX_NAME_BYTES
  ) {
    if (!characters.length) throw new Error("Name suffix exceeds bounds");
    characters.pop();
  }
  const parent = parentOf(path);
  const renamed = `${characters.join("")}${suffix}`;
  return parent ? `${parent}/${renamed}` : renamed;
}

/**
 * Where a conflicting copy of `path` goes: beside it, named as NOTE names its
 * own conflict copies of notes, `<name> conflict <8 hex>.md`. An attachment
 * keeps its extension last too, where NOTE would append the suffix.
 */
export const conflictPath = (
  path: string,
  id: () => string = () => crypto.randomUUID(),
) => besidePath(path, "conflict", id);

/** Where an item caught in a cycle of renames waits while the item holding its new name moves out. */
export const movingPath = (path: string, id: () => string) =>
  besidePath(path, "moving", id);
