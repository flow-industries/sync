import { sha256 } from "./hash";
import { exclusion, isNotePath, pathKey } from "./paths";
import {
  type Entry,
  type LocalNote,
  plan,
  type RemoteNote,
  type Step,
} from "./plan";

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}
/**
 * The Obsidian vault as sync sees it. Every write is conditional, so an edit
 * the person makes while a round runs is never overwritten: the write
 * reports false and the next round picks the edit up.
 */
export interface LocalVault {
  /** Every file Obsidian knows of; its config folder and hidden files aren't among them. */
  list(): Promise<LocalFile[]>;
  read(path: string): Promise<string>;
  /** Creates the file and any missing folders; false when something is already there. */
  create(path: string, source: string): Promise<boolean>;
  /** Replaces the text only if it is still exactly `expected`. */
  replace(path: string, expected: string, next: string): Promise<boolean>;
  /** Renames without rewriting links elsewhere; false when `to` is taken or `from` is gone. */
  move(from: string, to: string): Promise<boolean>;
  /** Moves the file to the trash Obsidian is set to use. */
  trash(path: string): Promise<void>;
}
export interface RemoteNoteView {
  id: string;
  path: string;
  source: string;
  revision?: string;
  digest?: string;
}
/** The linked NOTE vault, as the device client's `DeviceVault` offers it. */
export interface RemoteVault {
  read(): Promise<{ notes: RemoteNoteView[] }>;
  /** Resolves with the revision the saved text now has. */
  saveNote(note: RemoteNoteView): Promise<{ revision: string; digest: string }>;
  rename(id: string, path: string): Promise<void>;
  remove(id: string): Promise<void>;
}
/** Where the entries live between rounds: outside the vault folder, per linked device. */
export interface SyncIndex {
  load(): Promise<Entry[]>;
  save(entries: Entry[]): Promise<void>;
  clear(): Promise<void>;
}
export interface Deletions {
  local: number;
  remote: number;
}
export interface RoundResult {
  applied: number;
  failed: { path: string; error: string }[];
  /** Attachments, which this version doesn't sync yet. */
  attachments: number;
  /** Notes whose names NOTE can't store, or notes in NOTE whose names this vault can't hold. */
  unsyncable: string[];
  /** Deletions waiting for the person to confirm them. */
  held: Deletions;
}
export interface EngineOptions {
  local: LocalVault;
  remote: RemoteVault;
  index: SyncIndex;
  configDir: string;
  /**
   * Asked before a round deletes many notes at once, since a vault that
   * suddenly reads as empty looks exactly like everything deleted.
   */
  confirmDeletions?(deletions: Deletions): Promise<boolean>;
  newId?(): string;
}

/** More deletions than this, and more than a tenth of the synced notes, need confirming. */
const MASS_DELETION = 10;
const MAX_PASSES = 3;

const deletionsOf = (steps: readonly Step[]): Deletions => ({
  local: steps.filter((step) => step.kind === "delete-local").length,
  remote: steps.filter((step) => step.kind === "delete-remote").length,
});
const isDeletion = (step: Step) =>
  step.kind === "delete-local" || step.kind === "delete-remote";

/**
 * Two-way sync between the Obsidian vault and the NOTE vault, one round at a
 * time. Each round reads both sides, plans against the last agreed state
 * (`Entry`), applies the plan, and repeats until nothing is left, so the
 * index learns the revisions its own writes produced.
 */
export class SyncEngine {
  private entries = new Map<string, Entry>();
  private remoteHashes = new Map<string, { revision: string; hash: string }>();
  private cached: RemoteNote[] | null = null;
  private running: Promise<RoundResult> | null = null;
  private again = false;
  private declined = new Set<string>();
  private approved = new Set<string>();
  private dirty = false;
  private stopped = false;
  private readonly newId: () => string;

  constructor(private readonly options: EngineOptions) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  async load() {
    this.entries = new Map(
      (await this.options.index.load()).map((entry) => [entry.id, entry]),
    );
  }

  /** The NOTE vault changed: the next round reads it again. */
  remoteChanged() {
    this.cached = null;
  }

  /** A file or folder Obsidian renamed, so the round carries the rename instead of a delete and a create. */
  renamed(from: string, to: string) {
    const prefix = `${from}/`;
    for (const entry of this.entries.values()) {
      const current = entry.moved ?? entry.path;
      const next =
        current === from
          ? to
          : current.startsWith(prefix)
            ? `${to}/${current.slice(prefix.length)}`
            : null;
      if (next === null) continue;
      if (next === entry.path) delete entry.moved;
      else entry.moved = next;
    }
  }

  /** Runs a round, or joins the one running and queues another after it. */
  run(): Promise<RoundResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const round = (async () => {
      try {
        let result: RoundResult;
        do {
          this.again = false;
          result = await this.round();
        } while (this.again);
        return result;
      } finally {
        this.running = null;
      }
    })();
    this.running = round;
    return round;
  }

  /** Asks again about deletions the person declined before. */
  reconsiderDeletions() {
    this.declined.clear();
  }

  /** Stops the round in progress before its next write; nothing runs after. */
  stop() {
    this.stopped = true;
  }

  /**
   * Forgets what the last sync agreed on, so the next round compares both
   * sides' text directly: equal text binds, different text keeps both. For
   * when the device's local database lost writes the index counts as synced.
   */
  rebase() {
    for (const entry of this.entries.values())
      Object.assign(entry, {
        hash: "",
        revision: "",
        digest: "",
        mtime: 0,
        size: 0,
      });
    this.dirty = true;
  }

  private async round(): Promise<RoundResult> {
    const result: RoundResult = {
      applied: 0,
      failed: [],
      attachments: 0,
      unsyncable: [],
      held: { local: 0, remote: 0 },
    };
    for (let pass = 0; pass < MAX_PASSES && !this.stopped; pass++) {
      result.unsyncable = [];
      const remote = await this.readRemote(result);
      const local = await this.scanLocal(result);
      const planned = plan({
        entries: [...this.entries.values()],
        local,
        remote,
        newId: this.newId,
      });
      const steps = await this.confirmed(planned, result);
      if (steps === "asked") {
        // Either side may have moved on while the person decided: plan again from fresh reads.
        this.remoteChanged();
        pass--;
        continue;
      }
      if (!steps.length) break;
      const failures = result.failed.length;
      for (const step of steps) {
        if (this.stopped) break;
        await this.apply(step, result);
      }
      this.dirty = true;
      if (result.failed.length > failures) break;
    }
    if (this.dirty) {
      this.dirty = false;
      await this.options.index.save([...this.entries.values()]);
    }
    return result;
  }

  /**
   * The steps to apply now. A mass deletion waits for the person; once they
   * answer, the answer sticks for those notes and the caller plans again.
   */
  private async confirmed(
    steps: Step[],
    result: RoundResult,
  ): Promise<Step[] | "asked"> {
    const keyOf = (step: Step) => `${step.kind}:${step.id}`;
    const deletions = steps.filter(isDeletion);
    const massive =
      deletions.length > MASS_DELETION &&
      deletions.length > this.entries.size / 10;
    if (!massive) {
      this.declined.clear();
      this.approved.clear();
    } else if (
      deletions.some(
        (step) =>
          !this.declined.has(keyOf(step)) && !this.approved.has(keyOf(step)),
      )
    ) {
      const yes = await this.options.confirmDeletions?.(deletionsOf(deletions));
      for (const step of deletions)
        (yes ? this.approved : this.declined).add(keyOf(step));
      return "asked";
    }
    const held = new Set<Step>(
      deletions.filter((step) => this.declined.has(keyOf(step))),
    );
    result.held = deletionsOf([...held]);
    return steps.filter((step) => !held.has(step));
  }

  private async readRemote(result: RoundResult): Promise<RemoteNote[]> {
    if (!this.cached) {
      const { notes } = await this.options.remote.read();
      const hashed: RemoteNote[] = [];
      for (const note of notes) {
        const revision = note.revision ?? "";
        const known = this.remoteHashes.get(note.id);
        const hash =
          known && known.revision === revision && revision
            ? known.hash
            : await sha256(note.source);
        this.remoteHashes.set(note.id, { revision, hash });
        hashed.push({ ...note, hash });
      }
      this.cached = hashed;
    }
    return this.cached.filter((note) => {
      if (!exclusion(note.path, this.options.configDir)) return true;
      result.unsyncable.push(note.path);
      return false;
    });
  }

  private async scanLocal(result: RoundResult): Promise<LocalNote[]> {
    const byPath = new Map(
      [...this.entries.values()].map((entry) => [
        pathKey(entry.moved ?? entry.path),
        entry,
      ]),
    );
    result.attachments = 0;
    const files = new Map<string, LocalFile[]>();
    for (const file of await this.options.local.list()) {
      if (exclusion(file.path, this.options.configDir)) {
        if (isNotePath(file.path)) result.unsyncable.push(file.path);
        continue;
      }
      if (!isNotePath(file.path)) {
        result.attachments++;
        continue;
      }
      const key = pathKey(file.path);
      files.set(key, [...(files.get(key) ?? []), file]);
    }
    const notes: LocalNote[] = [];
    for (const [key, group] of files) {
      const entry = byPath.get(key);
      // Names that differ only in case are one note to NOTE: only the synced one syncs.
      const file =
        group.length === 1
          ? group[0]
          : group.find(
              (candidate) => candidate.path === (entry?.moved ?? entry?.path),
            );
      for (const other of group)
        if (other !== file) result.unsyncable.push(other.path);
      if (!file) continue;
      if (entry && entry.mtime === file.mtime && entry.size === file.size) {
        notes.push({ path: file.path, hash: entry.hash });
        continue;
      }
      const source = await this.options.local.read(file.path);
      const hash = await sha256(source);
      // The listing's stat predates the read, so a later edit still shows as a new stat.
      if (entry?.hash === hash) {
        entry.mtime = file.mtime;
        entry.size = file.size;
        this.dirty = true;
      }
      notes.push({ path: file.path, hash, source });
    }
    return notes;
  }

  private async apply(step: Step, result: RoundResult) {
    try {
      if (step.kind === "forget") this.entries.delete(step.id);
      else if (step.kind === "delete-remote") {
        await this.options.remote.remove(step.id);
        this.remoteChanged();
        this.entries.delete(step.id);
      } else if (step.kind === "delete-local") {
        if ((await this.unchanged(step.local)) && !this.stopped) {
          await this.options.local.trash(step.local.path);
          this.entries.delete(step.id);
        }
      } else await this.update(step);
      result.applied++;
    } catch (error) {
      result.failed.push({
        path:
          step.kind === "update"
            ? step.path
            : step.kind === "delete-local"
              ? step.local.path
              : step.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.remoteChanged();
    }
  }

  /** The local file still holds what the plan saw: its text, or the hash of text it didn't need to read. */
  private async unchanged(local: LocalNote): Promise<string | null> {
    const current = await this.options.local.read(local.path);
    return (await sha256(current)) === local.hash ? current : null;
  }

  private async update(step: Extract<Step, { kind: "update" }>) {
    const { id, path, content, local, remote, copy } = step;
    const { local: files, remote: vault } = this.options;
    let revision = remote?.revision ?? "";
    let digest = remote?.digest ?? "";
    let hash = remote?.hash ?? local?.hash ?? "";
    if (copy) {
      const source = local?.source;
      if (source === undefined) throw new Error("Conflict without local text");
      if (!(await files.create(copy, source)))
        throw new Error(`${copy} already exists`);
      const copyId = this.newId();
      const saved = await vault.saveNote({ id: copyId, path: copy, source });
      this.remoteChanged();
      this.record({
        id: copyId,
        path: copy,
        hash: local?.hash ?? "",
        ...saved,
      });
    }
    if (content === "local") {
      const source = local?.source;
      if (source === undefined) throw new Error("Push without local text");
      ({ revision, digest } = await vault.saveNote({
        id,
        path,
        source,
        revision: remote?.revision,
        digest: remote?.digest,
      }));
      this.remoteChanged();
      hash = local?.hash ?? "";
    } else if (remote && remote.path !== path) {
      await vault.rename(id, path);
      this.remoteChanged();
    }
    if (this.stopped) throw new Error("Sync stopped");
    if (local && local.path !== path) {
      if (!(await files.move(local.path, path)))
        throw new Error(`Couldn't move ${local.path} to ${path}`);
      // Recorded now, so a write that fails next still finds the file where it went.
      const entry = this.entries.get(id);
      if (entry) entry.moved = path;
    }
    if (content === "remote" && remote) {
      const written = local
        ? await this.replaceAt(path, local, remote.source)
        : await files.create(path, remote.source);
      if (!written) throw new Error(`${path} changed while syncing`);
    }
    this.record({ id, path, hash, revision, digest });
  }

  private async replaceAt(path: string, local: LocalNote, next: string) {
    const current = await this.unchanged({ ...local, path });
    if (current === null) return false;
    return current === next || this.options.local.replace(path, current, next);
  }

  /**
   * Records what a step left on both sides. Its stat stays unknown, so the
   * next scan reads the file once and takes the stat from that listing: one
   * taken now could already include an edit made after this write.
   */
  private record(entry: Pick<Entry, "id" | "path" | "hash"> & Partial<Entry>) {
    this.entries.set(entry.id, {
      revision: "",
      digest: "",
      ...entry,
      mtime: 0,
      size: 0,
    });
  }
}
