import type {
  LocalFile,
  LocalVault,
  RemoteNoteView,
  RemoteVault,
  RevisionBase,
  SyncIndex,
  WriteOptions,
} from "../src/engine";
import { isNotePath, pathKey } from "../src/paths";
import type { Body, Entry } from "../src/plan";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An Obsidian vault in memory; `beforeWrite` lets a test edit a file between a read and a write. */
export class MemoryVault implements LocalVault {
  files = new Map<string, { body: Body; mtime: number }>();
  trashed: string[] = [];
  beforeWrite?: (path: string) => void;
  private clock = 1;

  put(path: string, body: Body) {
    this.files.set(path, { body, mtime: this.clock++ });
  }
  text(path: string) {
    const body = this.files.get(path)?.body;
    return body === undefined || typeof body === "string"
      ? body
      : decoder.decode(body);
  }
  async list(): Promise<LocalFile[]> {
    return [...this.files].map(([path, file]) => ({
      path,
      mtime: file.mtime,
      size:
        typeof file.body === "string"
          ? encoder.encode(file.body).length
          : file.body.length,
    }));
  }
  private body(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`No file ${path}`);
    return file.body;
  }
  async read(path: string) {
    const body = this.body(path);
    return typeof body === "string" ? body : decoder.decode(body);
  }
  async readBinary(path: string) {
    const body = this.body(path);
    return typeof body === "string" ? encoder.encode(body) : body.slice();
  }
  private taken(path: string) {
    return [...this.files.keys()].some((key) => pathKey(key) === pathKey(path));
  }
  async create(path: string, body: Body) {
    this.beforeWrite?.(path);
    if (this.taken(path)) return false;
    this.put(path, typeof body === "string" ? body : body.slice());
    return true;
  }
  async replace(path: string, expected: string, next: string) {
    this.beforeWrite?.(path);
    if (this.files.get(path)?.body !== expected) return false;
    this.put(path, next);
    return true;
  }
  async overwrite(path: string, bytes: Uint8Array) {
    this.beforeWrite?.(path);
    this.put(path, bytes.slice());
  }
  async move(from: string, to: string) {
    const file = this.files.get(from);
    if (!file || (pathKey(from) !== pathKey(to) && this.taken(to)))
      return false;
    this.files.delete(from);
    this.put(to, file.body);
    return true;
  }
  async trash(path: string) {
    this.files.delete(path);
    this.trashed.push(path);
  }
}

/** What the device client throws for a compare-and-swap write that lost: `NoteChangedError`. */
export class StaleError extends Error {
  constructor() {
    super("This note changed. Read it again.");
  }
}
export const isStale = (error: unknown) => error instanceof StaleError;

interface RemoteRow extends RevisionBase {
  id: string;
  path: string;
  body: Body;
}

/**
 * A NOTE vault in memory that places bases as the device client does: a save
 * names any revision the item has had, or with `{ current: true }` the stored
 * one; a rename or remove with a base, the stored one. `beforeWrite` lets a
 * test land a NOTE edit between a round's read and its write.
 */
export class MemoryRemote implements RemoteVault {
  items = new Map<string, RemoteRow>();
  removed: string[] = [];
  beforeWrite?: (id: string) => void;
  private revisions = 0;
  private history = new Map<string, Set<string>>();

  put(id: string, path: string, body: Body) {
    this.commit({ id, path, body });
  }
  byPath(path: string) {
    return [...this.items.values()].find((item) => item.path === path);
  }
  text(path: string) {
    const body = this.byPath(path)?.body;
    return body === undefined || typeof body === "string"
      ? body
      : decoder.decode(body);
  }
  private commit(row: Omit<RemoteRow, keyof RevisionBase>): RevisionBase {
    const revision = `r${++this.revisions}`;
    const saved = { revision, digest: `d-${revision}` };
    this.items.set(row.id, { ...row, ...saved });
    this.history.set(
      row.id,
      (this.history.get(row.id) ?? new Set()).add(revision),
    );
    return saved;
  }
  private collides(id: string, path: string) {
    return [...this.items.values()].some(
      (item) => item.id !== id && pathKey(item.path) === pathKey(path),
    );
  }
  private write(
    row: Omit<RemoteRow, keyof RevisionBase>,
    base: Partial<RevisionBase>,
    options: WriteOptions = {},
  ) {
    this.beforeWrite?.(row.id);
    this.check(row.id, base, options.current);
    if (this.collides(row.id, row.path))
      throw new Error("Filesystem path collision");
    return this.commit(row);
  }
  private check(
    id: string,
    base: Partial<RevisionBase> | undefined,
    current = false,
  ) {
    const stored = this.items.get(id);
    if (!stored) return;
    const placed = current
      ? base?.revision === stored.revision
      : !!base?.revision && !!this.history.get(id)?.has(base.revision);
    if (!placed) throw new StaleError();
  }
  async read() {
    const notes: RemoteNoteView[] = [];
    for (const { id, path, body, revision, digest } of this.items.values())
      if (typeof body === "string")
        notes.push({ id, path, source: body, revision, digest });
    return { notes };
  }
  async listAttachments() {
    return [...this.items.values()]
      .filter((item) => typeof item.body !== "string")
      .map(({ id, path, revision, digest }) => ({
        id,
        path,
        revision,
        digest,
      }));
  }
  async readAttachment(id: string) {
    const body = this.items.get(id)?.body;
    if (!(body instanceof Uint8Array)) throw new Error("Missing attachment");
    return body.slice();
  }
  async saveNote(note: RemoteNoteView, options?: WriteOptions) {
    if (!isNotePath(note.path)) throw new Error("Note path must end in .md");
    return this.write(
      { id: note.id, path: note.path, body: note.source },
      note,
      options,
    );
  }
  async saveAttachment(
    attachment: {
      id: string;
      path: string;
      bytes: Uint8Array;
      revision?: string;
      digest?: string;
    },
    options?: WriteOptions,
  ) {
    if (isNotePath(attachment.path))
      throw new Error("This path is reserved for notes and preferences.");
    return this.write(
      {
        id: attachment.id,
        path: attachment.path,
        body: attachment.bytes.slice(),
      },
      attachment,
      options,
    );
  }
  async rename(id: string, path: string, base?: RevisionBase) {
    this.beforeWrite?.(id);
    const current = this.items.get(id);
    if (!current) throw new Error("Missing note");
    if (base) this.check(id, base, true);
    if (this.collides(id, path)) throw new Error("Filesystem path collision");
    return this.commit({ ...current, path });
  }
  async remove(id: string, base?: RevisionBase) {
    this.beforeWrite?.(id);
    if (base) this.check(id, base, true);
    this.items.delete(id);
    this.removed.push(id);
  }
}

export class MemoryIndex implements SyncIndex {
  entries: Entry[] = [];
  async load() {
    return structuredClone(this.entries);
  }
  async save(entries: Entry[]) {
    this.entries = structuredClone(entries);
  }
  async clear() {
    this.entries = [];
  }
}
