import type {
  LocalFile,
  LocalVault,
  RemoteNoteView,
  RemoteVault,
  SyncIndex,
} from "../src/engine";
import { pathKey } from "../src/paths";
import type { Entry } from "../src/plan";

/** An Obsidian vault in memory; `beforeWrite` lets a test edit a file between a read and a write. */
export class MemoryVault implements LocalVault {
  files = new Map<string, { source: string; mtime: number }>();
  trashed: string[] = [];
  beforeWrite?: (path: string) => void;
  private clock = 1;

  put(path: string, source: string) {
    this.files.set(path, { source, mtime: this.clock++ });
  }
  text(path: string) {
    return this.files.get(path)?.source;
  }
  async list(): Promise<LocalFile[]> {
    return [...this.files].map(([path, file]) => ({
      path,
      mtime: file.mtime,
      size: file.source.length,
    }));
  }
  async read(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`No file ${path}`);
    return file.source;
  }
  private taken(path: string) {
    return [...this.files.keys()].some((key) => pathKey(key) === pathKey(path));
  }
  async create(path: string, source: string) {
    this.beforeWrite?.(path);
    if (this.taken(path)) return false;
    this.put(path, source);
    return true;
  }
  async replace(path: string, expected: string, next: string) {
    this.beforeWrite?.(path);
    if (this.files.get(path)?.source !== expected) return false;
    this.put(path, next);
    return true;
  }
  async move(from: string, to: string) {
    const file = this.files.get(from);
    if (!file || (pathKey(from) !== pathKey(to) && this.taken(to)))
      return false;
    this.files.delete(from);
    this.put(to, file.source);
    return true;
  }
  async trash(path: string) {
    this.files.delete(path);
    this.trashed.push(path);
  }
}

/** A NOTE vault in memory that refuses saves on a revision it can't place, as the device client does. */
export class MemoryRemote implements RemoteVault {
  notes = new Map<string, Required<RemoteNoteView>>();
  removed: string[] = [];
  private revisions = 0;

  put(id: string, path: string, source: string) {
    this.notes.set(id, { id, path, source, ...this.revision() });
  }
  byPath(path: string) {
    return [...this.notes.values()].find((note) => note.path === path);
  }
  private revision() {
    const revision = `r${++this.revisions}`;
    return { revision, digest: `d-${revision}` };
  }
  private collides(id: string, path: string) {
    return [...this.notes.values()].some(
      (note) => note.id !== id && pathKey(note.path) === pathKey(path),
    );
  }
  async read() {
    return { notes: [...this.notes.values()].map((note) => ({ ...note })) };
  }
  async saveNote(note: RemoteNoteView) {
    const current = this.notes.get(note.id);
    if (current && current.revision !== note.revision)
      throw new Error("This note changed. Read it again.");
    if (this.collides(note.id, note.path))
      throw new Error("Filesystem path collision");
    const saved = this.revision();
    this.notes.set(note.id, { ...note, ...saved });
    return saved;
  }
  async rename(id: string, path: string) {
    const current = this.notes.get(id);
    if (!current) throw new Error("Missing note");
    if (this.collides(id, path)) throw new Error("Filesystem path collision");
    this.notes.set(id, { ...current, path, ...this.revision() });
  }
  async remove(id: string) {
    this.notes.delete(id);
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
