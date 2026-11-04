import { conflictPath } from "./conflicts";
import { pathKey } from "./paths";

/** What both sides agreed a note was at the last sync. */
export interface Entry {
  id: string;
  path: string;
  /** Where the file is now, when it was renamed here since the last sync. */
  moved?: string;
  /** The remote revision synced; empty until a read or a save names it. */
  revision: string;
  digest: string;
  /** SHA-256 of the source synced. */
  hash: string;
  /** The local file's stat at the last sync, so an unchanged file isn't read again. */
  mtime: number;
  size: number;
}
/** A note file in the Obsidian vault; `source` is read whenever it may have changed. */
export interface LocalNote {
  path: string;
  hash: string;
  source?: string;
}
export interface RemoteNote {
  id: string;
  path: string;
  source: string;
  revision?: string;
  digest?: string;
  hash: string;
}

/**
 * One note's change. An update writes `content`'s side over the other at
 * `path` (`same`: only paths or the index change), and `copy` keeps the
 * local text as a new note beside it when both sides edited it.
 */
export type Step =
  | {
      kind: "update";
      id: string;
      path: string;
      content: "local" | "remote" | "same";
      local?: LocalNote;
      remote?: RemoteNote;
      copy?: string;
    }
  | { kind: "delete-local"; id: string; local: LocalNote }
  | { kind: "delete-remote"; id: string }
  | { kind: "forget"; id: string };

export interface PlanInput {
  entries: readonly Entry[];
  local: readonly LocalNote[];
  remote: readonly RemoteNote[];
  newId?: () => string;
}

const currentPath = (entry: Entry) => entry.moved ?? entry.path;
/** The same name, whatever Unicode normalization the file system or another device chose; case still counts. */
const samePath = (a: string, b: string) =>
  a.normalize("NFC") === b.normalize("NFC");

/**
 * Pairs each entry with its local file. A rename Obsidian reported claims its
 * file before an entry still at that path, which the person deleted first. A
 * file renamed while sync wasn't watching shows up as its entry's file gone
 * and a new file with the same text: they pair when exactly one matches.
 */
function claimLocal(
  entries: readonly Entry[],
  local: Map<string, LocalNote>,
): Map<string, LocalNote> {
  const owners = new Map<string, Entry>();
  const byMove = [...entries].sort(
    (a, b) => Number(!a.moved) - Number(!b.moved),
  );
  for (const entry of byMove) {
    const key = pathKey(currentPath(entry));
    if (local.has(key) && !owners.has(key)) owners.set(key, entry);
  }
  const found = new Map<string, LocalNote>();
  for (const [key, entry] of owners) {
    const note = local.get(key);
    if (note) found.set(entry.id, note);
  }
  const unclaimed = [...local]
    .filter(([key]) => !owners.has(key))
    .map(([, note]) => note);
  const taken = new Set<LocalNote>();
  for (const entry of entries) {
    if (found.has(entry.id)) continue;
    const matches = unclaimed.filter((note) => note.hash === entry.hash);
    const [match] = matches;
    if (matches.length !== 1 || !match || taken.has(match)) continue;
    taken.add(match);
    found.set(entry.id, match);
  }
  return found;
}

function updateOf(
  entry: Entry,
  local: LocalNote,
  remote: RemoteNote,
  newId: () => string,
): Step | null {
  const localChanged = local.hash !== entry.hash;
  const remoteChanged = remote.hash !== entry.hash;
  const localMoved = !samePath(local.path, entry.path);
  const remoteMoved = !samePath(remote.path, entry.path);
  // Both renamed: the remote name wins, as every other device converges on it.
  const path = remoteMoved || !localMoved ? remote.path : local.path;
  let content: "local" | "remote" | "same" = "same";
  let copy: string | undefined;
  if (localChanged && !remoteChanged) content = "local";
  else if (remoteChanged && !localChanged) content = "remote";
  else if (localChanged && remoteChanged && local.hash !== remote.hash) {
    content = "remote";
    copy = conflictPath(path, newId);
  }
  if (
    content === "same" &&
    samePath(path, local.path) &&
    samePath(path, remote.path) &&
    samePath(path, entry.path) &&
    !entry.moved &&
    (remote.revision ?? "") === entry.revision
  )
    return null;
  return { kind: "update", id: entry.id, path, content, local, remote, copy };
}

/**
 * Three-way reconciliation of one sync round: each entry is the base its
 * note was at, and either side's change since then wins over the other's
 * silence. An edit beats a deletion, a remote rename beats a local one, and
 * when both sides edited, the remote text keeps the path while the local
 * text becomes a conflict copy beside it, as NOTE resolves its own. Local
 * paths must be unique by `pathKey`.
 */
export function plan({
  entries,
  local: localNotes,
  remote: remoteNotes,
  newId = () => crypto.randomUUID(),
}: PlanInput): Step[] {
  const local = new Map(localNotes.map((note) => [pathKey(note.path), note]));
  const remote = new Map(remoteNotes.map((note) => [note.id, note]));
  const claimed = claimLocal(entries, local);
  const claimedLocal = new Set<string>();
  const claimedRemote = new Set<string>();
  const steps: Step[] = [];

  for (const entry of entries) {
    const r = remote.get(entry.id);
    const l = claimed.get(entry.id);
    if (r) claimedRemote.add(r.id);
    if (l) claimedLocal.add(pathKey(l.path));
    if (!l && !r) steps.push({ kind: "forget", id: entry.id });
    else if (!l && r)
      steps.push(
        r.hash === entry.hash
          ? { kind: "delete-remote", id: entry.id }
          : {
              kind: "update",
              id: r.id,
              path: r.path,
              content: "remote",
              remote: r,
            },
      );
    else if (l && !r) {
      if (l.hash === entry.hash)
        steps.push({ kind: "delete-local", id: entry.id, local: l });
      else {
        steps.push({ kind: "forget", id: entry.id });
        steps.push({
          kind: "update",
          id: newId(),
          path: l.path,
          content: "local",
          local: l,
        });
      }
    } else if (l && r) {
      const step = updateOf(entry, l, r, newId);
      if (step) steps.push(step);
    }
  }

  for (const r of remoteNotes) {
    if (claimedRemote.has(r.id)) continue;
    const key = pathKey(r.path);
    const l = claimedLocal.has(key) ? undefined : local.get(key);
    if (l) claimedLocal.add(key);
    if (!l)
      steps.push({
        kind: "update",
        id: r.id,
        path: r.path,
        content: "remote",
        remote: r,
      });
    else if (l.hash === r.hash)
      steps.push({
        kind: "update",
        id: r.id,
        path: r.path,
        content: "same",
        local: l,
        remote: r,
      });
    else
      steps.push({
        kind: "update",
        id: r.id,
        path: r.path,
        content: "remote",
        local: l,
        remote: r,
        copy: conflictPath(r.path, newId),
      });
  }

  // A new file where a synced note is headed, or already is in NOTE, steps aside as a conflict copy.
  const headed = new Set([
    ...remoteNotes.map((note) => pathKey(note.path)),
    ...steps.flatMap((step) =>
      step.kind === "update" ? [pathKey(step.path)] : [],
    ),
  ]);
  for (const [key, l] of local)
    if (!claimedLocal.has(key))
      steps.push({
        kind: "update",
        id: newId(),
        path: headed.has(key) ? conflictPath(l.path, newId) : l.path,
        content: "local",
        local: l,
      });

  return steps.sort((a, b) => order(a) - order(b));
}

/**
 * Remote deletions free their paths first, local edits land before remote
 * renames (NOTE repairs links when it renames, which would otherwise race
 * Obsidian's own link updates), and remote creates follow the renames that
 * free their paths. Local writes come last, once the remote is settled.
 */
function order(step: Step): number {
  if (step.kind === "delete-remote") return 0;
  if (step.kind !== "update") return 4;
  if (step.content === "local" && step.remote)
    return step.remote.path === step.path ? 1 : 2;
  if (step.remote && step.remote.path !== step.path) return 2;
  if (step.content === "local") return 3;
  return 5;
}
