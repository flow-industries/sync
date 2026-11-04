import { movingPath } from "./conflicts";
import { sha256 } from "./hash";
import { exclusion, isNotePath, pathKey } from "./paths";
import {
  type Body,
  type Entry,
  type LocalItem,
  plan,
  type RemoteItem,
  type Step,
} from "./plan";

export interface LocalFile {
  path: string;
  mtime: number;
  size: number;
}
/**
 * The Obsidian vault as sync sees it. Writes over text are conditional, so an
 * edit the person makes while a round runs is never overwritten: the write
 * reports false and the next round picks the edit up.
 */
export interface LocalVault {
  /** Every file Obsidian knows of; its config folder and hidden files aren't among them. */
  list(): Promise<LocalFile[]>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Creates the file and any missing folders; false when something is already there. */
  create(path: string, body: Body): Promise<boolean>;
  /** Replaces the text only if it is still exactly `expected`. */
  replace(path: string, expected: string, next: string): Promise<boolean>;
  /** Replaces an attachment's bytes, which the caller checked just before. */
  overwrite(path: string, bytes: Uint8Array): Promise<void>;
  /** Renames without rewriting links elsewhere; false when `to` is taken or `from` is gone. */
  move(from: string, to: string): Promise<boolean>;
  /** Moves the file to the trash Obsidian is set to use. */
  trash(path: string): Promise<void>;
}
export interface RevisionBase {
  revision: string;
  digest: string;
}
export interface RemoteNoteView {
  id: string;
  path: string;
  source: string;
  revision?: string;
  digest?: string;
}
export interface RemoteAttachmentView {
  id: string;
  path: string;
  revision: string;
  digest: string;
}
/** `current`: the write is refused unless its base is the stored revision. */
export interface WriteOptions {
  current?: boolean;
}
/**
 * The linked NOTE vault, as the device client's `DeviceVault` offers it.
 * Every write the engine makes is compare-and-swap: a save with
 * `{ current: true }`, a rename or remove with the base the plan read.
 */
export interface RemoteVault {
  read(): Promise<{ notes: RemoteNoteView[] }>;
  listAttachments(): Promise<RemoteAttachmentView[]>;
  readAttachment(id: string): Promise<Uint8Array>;
  /** Each save resolves with the revision the content now has. */
  saveNote(note: RemoteNoteView, options?: WriteOptions): Promise<RevisionBase>;
  saveAttachment(
    attachment: {
      id: string;
      path: string;
      bytes: Uint8Array;
      revision?: string;
      digest?: string;
    },
    options?: WriteOptions,
  ): Promise<RevisionBase>;
  rename(id: string, path: string, base?: RevisionBase): Promise<RevisionBase>;
  remove(id: string, base?: RevisionBase): Promise<void>;
}
/** Where the entries live between rounds: outside the vault folder, per linked device. */
export interface SyncIndex {
  load(): Promise<Entry[]>;
  save(entries: Entry[]): Promise<void>;
}
export interface Deletions {
  local: number;
  remote: number;
}
export interface RoundResult {
  applied: number;
  failed: { path: string; error: string }[];
  /**
   * Files left out: names NOTE can't store, names that differ only in case,
   * attachments over `MAX_ATTACHMENT_BYTES`, and NOTE items under names this
   * vault can't hold. A synced item that becomes one of these is left alone
   * on both sides, never deleted.
   */
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
  confirmDeletions?: (deletions: Deletions) => Promise<boolean>;
  /**
   * Whether a write was refused because the item changed in NOTE since the
   * round read it; the round reads again and plans from there.
   */
  stale?: (error: unknown) => boolean;
  newId?: () => string;
}

/** More deletions than this, and more than a tenth of the synced items, need confirming. */
const MASS_DELETION = 10;
/** More deletions than this need confirming, however large the vault. */
const MASS_DELETION_CEILING = 50;
/** NOTE imports files up to this size; a larger attachment stays on this device. */
export const MAX_ATTACHMENT_BYTES = 32_000_000;
const MAX_PASSES = 3;

const deletionsOf = (steps: readonly Step[]): Deletions => ({
  local: steps.filter((step) => step.kind === "delete-local").length,
  remote: steps.filter((step) => step.kind === "delete-remote").length,
});
const baseOf = (item: RemoteItem): RevisionBase | undefined =>
  item.revision && item.digest
    ? { revision: item.revision, digest: item.digest }
    : undefined;
const isDeletion = (step: Step) =>
  step.kind === "delete-local" || step.kind === "delete-remote";
/** Whether going from `from` to `to` leaves a path another item could take; a change of case doesn't. */
const leaves = (from: string, to: string) => pathKey(from) !== pathKey(to);

type Side = "local" | "remote";
/**
 * The paths each side's items are leaving this pass, by the id leaving each.
 * A rename into one of them waits until its holder has left, and a cycle of
 * renames, such as two notes swapping names, moves one item aside first.
 */
class Vacating {
  private readonly sides: Record<Side, Map<string, string>> = {
    local: new Map(),
    remote: new Map(),
  };

  constructor(steps: readonly Step[]) {
    for (const step of steps) {
      if (step.kind === "delete-local")
        this.leaving("local", step.local.path, step.id);
      else if (step.kind === "delete-remote")
        this.leaving("remote", step.remote.path, step.id);
      else if (step.kind === "update") {
        if (step.local && leaves(step.local.path, step.path))
          this.leaving("local", step.local.path, step.id);
        if (step.remote && leaves(step.remote.path, step.path))
          this.leaving("remote", step.remote.path, step.id);
      }
    }
  }

  private leaving(side: Side, path: string, id: string) {
    this.sides[side].set(pathKey(path), id);
  }

  /** The item still holding the path `step` moves into, on whichever side it moves. */
  holder(step: Step): string | null {
    if (step.kind !== "update") return null;
    const key = pathKey(step.path);
    for (const side of ["local", "remote"] as const) {
      const item = step[side];
      const holder = this.sides[side].get(key);
      if (item && leaves(item.path, step.path) && holder && holder !== step.id)
        return holder;
    }
    return null;
  }

  left(side: Side, path: string) {
    this.sides[side].delete(pathKey(path));
  }
}

/**
 * Two-way sync between the Obsidian vault and the NOTE vault, one round at a
 * time. Each round reads both sides, plans against the last agreed state
 * (`Entry`), applies the plan, and repeats until nothing is left, so the
 * index learns the revisions its own writes produced.
 */
export class SyncEngine {
  private entries = new Map<string, Entry>();
  private remoteHashes = new Map<string, { revision: string; hash: string }>();
  private cached: RemoteItem[] | null = null;
  private running: Promise<RoundResult> | null = null;
  private again = false;
  private declined = new Set<string>();
  private approved = new Set<string>();
  private dirty = false;
  private stopped = false;
  private vacating = new Vacating([]);
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
      unsyncable: [],
      held: { local: 0, remote: 0 },
    };
    for (let pass = 0; pass < MAX_PASSES && !this.stopped; pass++) {
      result.unsyncable = [];
      const frozen = new Set<string>();
      const remote = await this.readRemote(result, frozen);
      const local = await this.scanLocal(result, frozen);
      const frozenPaths = new Set(
        [...frozen].flatMap((id) => {
          const entry = this.entries.get(id);
          return entry ? [pathKey(entry.moved ?? entry.path)] : [];
        }),
      );
      const planned = plan({
        entries: [...this.entries.values()].filter(
          (entry) => !frozen.has(entry.id),
        ),
        local: local.filter((item) => !frozenPaths.has(pathKey(item.path))),
        remote: remote.filter((item) => !frozen.has(item.id)),
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
      this.vacating = new Vacating(steps);
      const waiting: Step[] = [];
      for (const step of steps) {
        if (this.stopped) break;
        if (this.vacating.holder(step)) waiting.push(step);
        else await this.apply(step, result);
      }
      await this.applyWaiting(waiting, result);
      this.dirty = true;
      if (result.failed.length > failures) break;
    }
    // A stopped engine was closed, unlinked or removed: its index may already be deleted, and must stay so.
    if (this.dirty && !this.stopped) {
      this.dirty = false;
      await this.options.index.save([...this.entries.values()]);
    }
    return result;
  }

  /**
   * Renames that waited for their new path: each goes once its holder left.
   * When every one waits on another that is waiting too, they form a cycle,
   * and one moves aside to a free name, which the next pass finishes. One
   * whose holder couldn't leave waits for the next round.
   */
  private async applyWaiting(waiting: Step[], result: RoundResult) {
    const inCycle = (step: Step) => {
      const seen = new Set<Step>();
      for (let current = step; !seen.has(current); ) {
        seen.add(current);
        const holder = this.vacating.holder(current);
        const next = waiting.find((other) => other.id === holder);
        if (!next) return false;
        if (next === step) return true;
        current = next;
      }
      return false;
    };
    while (waiting.length && !this.stopped) {
      const free = waiting.findIndex((step) => !this.vacating.holder(step));
      const cycle = waiting.findIndex(inCycle);
      const index = free === -1 ? cycle : free;
      if (index === -1) return;
      const [step] = waiting.splice(index, 1);
      if (step) await this.apply(step, result, free === -1);
    }
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
      deletions.length > MASS_DELETION_CEILING ||
      (deletions.length > MASS_DELETION &&
        deletions.length > this.entries.size / 10);
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

  /**
   * Both kinds of NOTE item, each with the hash of its content: a note's from
   * its text, an attachment's from the index when its revision is the one
   * synced, otherwise from its bytes, read once per revision.
   */
  private async readRemote(
    result: RoundResult,
    frozen: Set<string>,
  ): Promise<RemoteItem[]> {
    if (!this.cached) {
      const { remote } = this.options;
      const [{ notes }, attachments] = await Promise.all([
        remote.read(),
        remote.listAttachments(),
      ]);
      const items: RemoteItem[] = [];
      for (const note of notes)
        items.push({
          id: note.id,
          path: note.path,
          revision: note.revision,
          digest: note.digest,
          body: note.source,
          hash: await this.remoteHash(
            note.id,
            note.revision,
            () => note.source,
          ),
        });
      for (const attachment of attachments)
        items.push({
          ...attachment,
          hash: await this.remoteHash(attachment.id, attachment.revision, () =>
            remote.readAttachment(attachment.id),
          ),
        });
      this.cached = items;
    }
    return this.cached.filter((item) => {
      if (!exclusion(item.path, this.options.configDir)) return true;
      result.unsyncable.push(item.path);
      if (this.entries.has(item.id)) frozen.add(item.id);
      return false;
    });
  }

  private async remoteHash(
    id: string,
    revision: string | undefined,
    body: () => Body | Promise<Body>,
  ): Promise<string> {
    const synced = this.entries.get(id);
    if (revision && synced?.revision === revision && synced.hash)
      return synced.hash;
    const known = this.remoteHashes.get(id);
    if (revision && known?.revision === revision) return known.hash;
    const hash = await sha256(await body());
    this.remoteHashes.set(id, { revision: revision ?? "", hash });
    return hash;
  }

  private async scanLocal(
    result: RoundResult,
    frozen: Set<string>,
  ): Promise<LocalItem[]> {
    const byPath = new Map(
      [...this.entries.values()].map((entry) => [
        pathKey(entry.moved ?? entry.path),
        entry,
      ]),
    );
    const files = new Map<string, LocalFile[]>();
    for (const file of await this.options.local.list()) {
      const key = pathKey(file.path);
      if (
        exclusion(file.path, this.options.configDir) ||
        (!isNotePath(file.path) && file.size > MAX_ATTACHMENT_BYTES)
      ) {
        result.unsyncable.push(file.path);
        const entry = byPath.get(key);
        if (entry) frozen.add(entry.id);
        continue;
      }
      files.set(key, [...(files.get(key) ?? []), file]);
    }
    const items: LocalItem[] = [];
    for (const [key, group] of files) {
      const entry = byPath.get(key);
      // Names that differ only in case are one item to NOTE: only the synced one syncs.
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
        items.push({ path: file.path, hash: entry.hash });
        continue;
      }
      const body = await this.readLocal(file.path);
      const hash = await sha256(body);
      // The listing's stat predates the read, so a later edit still shows as a new stat.
      if (entry?.hash === hash) {
        entry.mtime = file.mtime;
        entry.size = file.size;
        this.dirty = true;
      }
      items.push({ path: file.path, hash, body });
    }
    return items;
  }

  private readLocal(path: string): Promise<Body> {
    return isNotePath(path)
      ? this.options.local.read(path)
      : this.options.local.readBinary(path);
  }

  private async apply(step: Step, result: RoundResult, aside = false) {
    try {
      if (step.kind === "forget") this.entries.delete(step.id);
      else if (step.kind === "delete-remote") {
        await this.options.remote.remove(step.id, baseOf(step.remote));
        this.remoteChanged();
        this.vacating.left("remote", step.remote.path);
        this.entries.delete(step.id);
      } else if (step.kind === "delete-local") {
        if ((await this.unchanged(step.local)) !== null && !this.stopped) {
          await this.options.local.trash(step.local.path);
          this.vacating.left("local", step.local.path);
          this.entries.delete(step.id);
        }
      } else await this.update(step, aside);
      result.applied++;
    } catch (error) {
      this.remoteChanged();
      if (this.options.stale?.(error)) return;
      result.failed.push({
        path:
          step.kind === "update"
            ? step.path
            : step.kind === "delete-local"
              ? step.local.path
              : step.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The local file's content, if it still is what the plan saw; null once it changed. */
  private async unchanged(local: LocalItem): Promise<Body | null> {
    const current = await this.readLocal(local.path);
    return (await sha256(current)) === local.hash ? current : null;
  }

  /**
   * Compare-and-swap: an edit that reached NOTE after the round read `base`
   * refuses the save instead of being replaced, and the round plans again.
   */
  private save(
    id: string,
    path: string,
    body: Body,
    base?: Partial<RevisionBase>,
  ) {
    const { remote } = this.options;
    const { revision, digest } = base ?? {};
    return typeof body === "string"
      ? remote.saveNote(
          { id, path, source: body, revision, digest },
          { current: true },
        )
      : remote.saveAttachment(
          { id, path, bytes: body, revision, digest },
          { current: true },
        );
  }

  /**
   * Writes one item's change. `aside` moves the side that renames to a free
   * name beside `path` instead, and records it so the next plan finishes
   * the rename from there.
   */
  private async update(step: Extract<Step, { kind: "update" }>, aside = false) {
    const { id, path, content, local, remote, copy } = step;
    const { local: files, remote: vault } = this.options;
    const temporary = aside ? movingPath(path, this.newId) : null;
    const remoteTo =
      temporary && remote && remote.path !== path ? temporary : path;
    const localTo =
      temporary && local && local.path !== path ? temporary : path;
    let base: RevisionBase = {
      revision: remote?.revision ?? "",
      digest: remote?.digest ?? "",
    };
    let hash = remote?.hash ?? local?.hash ?? "";
    // The item's own compare-and-swap write goes first, so a refused one leaves no conflict copy for the next plan to duplicate.
    if (content === "local") {
      const body = local?.body;
      if (body === undefined) throw new Error("Push without local content");
      base = await this.save(id, remoteTo, body, remote);
      this.remoteChanged();
      if (remote && remote.path !== path)
        this.vacating.left("remote", remote.path);
      hash = local?.hash ?? "";
    } else if (remote && remote.path !== path) {
      base = await vault.rename(id, remoteTo, baseOf(remote));
      this.remoteChanged();
      this.vacating.left("remote", remote.path);
    }
    if (copy) {
      const body = local?.body;
      if (body === undefined) throw new Error("Conflict without local content");
      if (!(await files.create(copy, body)))
        throw new Error(`${copy} already exists`);
      const copyId = this.newId();
      const saved = await this.save(copyId, copy, body);
      this.remoteChanged();
      this.record({
        id: copyId,
        path: copy,
        hash: local?.hash ?? "",
        ...saved,
      });
    }
    if (this.stopped) throw new Error("Sync stopped");
    if (local && local.path !== path) {
      if (!(await files.move(local.path, localTo)))
        throw new Error(`Couldn't move ${local.path} to ${localTo}`);
      this.vacating.left("local", local.path);
      // Recorded now, so a write that fails next still finds the file where it went.
      const entry = this.entries.get(id);
      if (entry) entry.moved = localTo;
    }
    if (content === "remote" && remote) {
      const body = remote.body ?? (await vault.readAttachment(id));
      const written = local
        ? await this.replaceAt(localTo, local, body)
        : await files.create(localTo, body);
      if (!written) throw new Error(`${localTo} changed while syncing`);
    }
    // Parked aside, the agreed path is the free name, so the side still at `path` reads to the next plan as the rename left to finish.
    const here = temporary && remoteTo === temporary ? { moved: path } : {};
    this.record({ id, path: temporary ?? path, ...here, hash, ...base });
  }

  private async replaceAt(path: string, local: LocalItem, next: Body) {
    const current = await this.unchanged({ ...local, path });
    if (current === null) return false;
    if (typeof current !== "string" || typeof next !== "string") {
      if (this.stopped) return false;
      await this.options.local.overwrite(path, next as Uint8Array);
      return true;
    }
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
