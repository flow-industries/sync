import type {
  LocalFile,
  LocalVault,
  RemoteNoteView,
  RemoteVault,
  RevisionBase,
  SyncIndex,
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

interface RemoteRow extends RevisionBase {
  id: string;
  path: string;
  body: Body;
}

/** A NOTE vault in memory that refuses saves on a revision it can't place, as the device client does. */
export class MemoryRemote implements RemoteVault {
  items = new Map<string, RemoteRow>();
  removed: string[] = [];
  private revisions = 0;

  put(id: string, path: string, body: Body) {
    this.items.set(id, { id, path, body, ...this.revision() });
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
  private revision(): RevisionBase {
    const revision = `r${++this.revisions}`;
    return { revision, digest: `d-${revision}` };
  }
  private collides(id: string, path: string) {
    return [...this.items.values()].some(
      (item) => item.id !== id && pathKey(item.path) === pathKey(path),
    );
  }
  private write(
    row: Omit<RemoteRow, keyof RevisionBase>,
    base: Partial<RevisionBase>,
  ) {
    const current = this.items.get(row.id);
    if (current && current.revision !== base.revision)
      throw new Error("This note changed. Read it again.");
    if (this.collides(row.id, row.path))
      throw new Error("Filesystem path collision");
    const saved = this.revision();
    this.items.set(row.id, { ...row, ...saved });
    return saved;
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
  async saveNote(note: RemoteNoteView) {
    if (!isNotePath(note.path)) throw new Error("Note path must end in .md");
    return this.write(
      { id: note.id, path: note.path, body: note.source },
      note,
    );
  }
  async saveAttachment(attachment: {
    id: string;
    path: string;
    bytes: Uint8Array;
    revision?: string;
    digest?: string;
  }) {
    if (isNotePath(attachment.path))
      throw new Error("This path is reserved for notes and preferences.");
    return this.write(
      {
        id: attachment.id,
        path: attachment.path,
        body: attachment.bytes.slice(),
      },
      attachment,
    );
  }
  async rename(id: string, path: string) {
    const current = this.items.get(id);
    if (!current) throw new Error("Missing note");
    if (this.collides(id, path)) throw new Error("Filesystem path collision");
    const saved = this.revision();
    this.items.set(id, { ...current, path, ...saved });
    return saved;
  }
  async remove(id: string) {
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
