/** Notes NOTE stores as text; every other file is an attachment. */
export const isNotePath = (path: string) => /\.mdx?$/iu.test(path);

/**
 * The key NOTE compares paths by: two paths with the same key can't both
 * exist in a vault, and a case-insensitive file system treats them as one.
 */
export function pathKey(path: string): string {
  return /^\p{ASCII}*$/u.test(path)
    ? path.toLowerCase()
    : path.normalize("NFC").toLocaleLowerCase("en-US");
}

const MAX_SEGMENT_BYTES = 255;
const MAX_DEPTH = 64;
const MAX_PATH_LENGTH = 4096;
const encoder = new TextEncoder();

/** Whether NOTE accepts `name` as one file or folder name, by the same rules its vault model enforces. */
export function isNoteSafeName(name: string): boolean {
  return !(
    !name ||
    encoder.encode(name).length > MAX_SEGMENT_BYTES ||
    name === "." ||
    name === ".." ||
    /[/\\<>:"|?*]/u.test(name) ||
    Array.from(name).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    /[. ]$/u.test(name) ||
    /^[A-Za-z]:/u.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
  );
}

export type Exclusion = "config" | "hidden" | "unsafe-name";

/**
 * Why a path stays out of sync in either direction, or null when it syncs.
 * Obsidian's config folder holds plugin code, so nothing is ever read from
 * or written into it, and neither is any hidden file or folder.
 */
export function exclusion(path: string, configDir: string): Exclusion | null {
  const segments = path.split("/");
  const config = pathKey(configDir.replace(/\/+$/u, ""));
  if (pathKey(segments[0] ?? "") === config) return "config";
  if (segments.some((segment) => segment.startsWith("."))) return "hidden";
  if (
    path.length > MAX_PATH_LENGTH ||
    segments.length > MAX_DEPTH ||
    !segments.every(isNoteSafeName)
  )
    return "unsafe-name";
  return null;
}

export const parentOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
};
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
