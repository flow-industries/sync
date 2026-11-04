import { type LinkedAccount, linkedAccount } from "./account";
import type { Custody } from "./custody";
import type {
  DeviceOptions,
  DeviceVault,
  LinkOptions,
  LinkPrompt,
  NoteDeviceFetch,
  TrustLoss,
} from "./device";
import {
  type Deletions,
  type LocalVault,
  type RoundResult,
  SyncEngine,
  type SyncIndex,
} from "./engine";
import type { IndexKey } from "./index-store";

/** The device client calls the controller makes. */
export interface DeviceClient {
  createDeviceSeed: () => Uint8Array;
  linkDevice: (seed: Uint8Array, options: LinkOptions) => Promise<unknown>;
  openDeviceVault: (
    seed: Uint8Array,
    options: DeviceOptions,
  ) => Promise<DeviceVault>;
  /** The status the device's sync reports once it lost access and wiped its keys. */
  locked: string;
  /** Whether the device publishes `status` only after a sync that read the vault. */
  followsRead: (status: string) => boolean;
  /** Whether a write was refused because the item changed since it was read (`NoteChangedError`). */
  stale: (error: unknown) => boolean;
}

export type Phase =
  | { kind: "unlinked" }
  | { kind: "linking"; prompt?: LinkPrompt }
  | { kind: "confirm"; account: LinkedAccount }
  | { kind: "opening" }
  | { kind: "open"; status: string }
  | { kind: "removed"; message: string }
  | { kind: "stopped"; message: string };

export type RemovalReason = "removed" | "revoked" | "unverified";
export const REMOVED: Record<RemovalReason, string> = {
  removed:
    "This vault was removed from your NOTE notepad's access. Link it again to keep syncing.",
  revoked: "Flow ID unlinked this vault. Link it again to keep syncing.",
  unverified:
    "This vault's link couldn't be verified. Link it again, and remove the unverified entry under Access in NOTE.",
};
export const STRANDED =
  "NOTE's key changed while edits from this vault were still waiting to sync. Nothing is overwritten this time: where NOTE has different text, this vault's is kept as a conflict copy beside it.";
export const LOCKED_ELSEWHERE =
  "This vault is already syncing in another Obsidian window.";
export const ALREADY_LINKED =
  "This vault is still linked. Unlink it before linking it again.";
export const KEY_MISSING =
  "This vault's device key is missing from Obsidian's secret storage, though its link isn't. Unlink it, then link it again.";

export interface ControllerOptions {
  custody: Custody;
  device: DeviceClient;
  /** Flow ID's origin. */
  host: string;
  fetch: NoteDeviceFetch;
  local: LocalVault;
  configDir: string;
  /** Whether Obsidian rewrites links as it renames a file ("Automatically update internal links"). */
  updatesLinks: () => boolean;
  /** The index of one linked device: a new link never plans against another device's base. */
  indexFor: (key: IndexKey) => SyncIndex;
  /** Deletes every index this Obsidian vault holds, for every device it was linked as. */
  forgetIndexes: () => Promise<void>;
  /**
   * Holds this vault's credential store for as long as the vault is open,
   * across every window of this app, or answers null when another holder
   * keeps it, so only one device transport ever refreshes its tokens.
   */
  hold: () => Promise<(() => void) | null>;
  /** Deletes the device client's local databases for this seed, unsynced edits included. */
  forgetDevice: (seed: Uint8Array) => Promise<void>;
  confirmDeletions: (deletions: Deletions) => Promise<boolean>;
  onChange: () => void;
  onTrustLoss: (loss: TrustLoss) => void;
  /** Tells the person something sync did that they didn't ask for. */
  notify: (message: string) => void;
}

const LOCAL_DEBOUNCE_MS = 1_500;
const REMOTE_DEBOUNCE_MS = 500;
const RETRY_MS = 30_000;
/** How long closing waits for the device's running work, a token refresh included, to finish. */
const DRAIN_MS = 15_000;

/** `work`, or nothing after `limit` ms; never rejects. */
function within(work: Promise<unknown>, limit: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, limit);
    void work
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

/**
 * Links, opens and syncs one Obsidian vault with its NOTE vault, and owns the
 * only open device vault, so a single device transport ever refreshes the
 * stored tokens. Nothing syncs until the person confirmed the account the
 * link bound, no round runs until the device has read the vault once since
 * it opened, and everything stops when the device loses access.
 */
export class SyncController {
  phase: Phase = { kind: "unlinked" };
  lastRound: RoundResult | null = null;
  private vault: DeviceVault | null = null;
  private engine: SyncEngine | null = null;
  private release: (() => void) | null = null;
  private unsubscribe: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private opening: Promise<void> | null = null;
  /** Bumped by every `close`, so work started before it notices and stops. */
  private generation = 0;
  private ready = false;
  private linking = false;
  /** The read in flight, so the statuses its own sync publishes don't start another. */
  private pulling: Promise<void> | null = null;
  /** An open still unlocking the vault, which a close must stop too before the lock goes. */
  private unlocking: Promise<DeviceVault> | null = null;
  /** Settles once the last closed device has stopped: nothing of it touches its database or the PDS. */
  private stopped: Promise<void> = Promise.resolve();
  /** Settles once the last closed device's lock is released. */
  private released: Promise<void> = Promise.resolve();
  /** The last stop or removal told to the person, so a retry that fails the same way stays quiet. */
  private told: string | null = null;
  /** Bumped by every `forget`, so an engine opened before it never saves into an index it deleted. */
  private forgets = 0;

  constructor(private readonly options: ControllerOptions) {}

  private nameAccount(did: string) {
    return linkedAccount(did, this.options.fetch);
  }

  /** The account the person confirmed, while linked. */
  account(): LinkedAccount | null {
    return this.options.custody.account();
  }

  /** Whether anything of a link is stored, which Unlink then clears. */
  stored(): boolean {
    const { custody } = this.options;
    return (
      custody.linked() || custody.seed() !== null || custody.account() !== null
    );
  }

  /** No usable link: unlinked, or a link whose key went missing, which only Unlink clears. */
  private unusable() {
    this.set(
      this.options.custody.linked()
        ? { kind: "stopped", message: KEY_MISSING }
        : { kind: "unlinked" },
    );
  }

  private set(phase: Phase) {
    this.phase = phase;
    // Mobile has no status bar: a stop is only seen if it's said.
    const notice =
      phase.kind === "removed"
        ? phase.message
        : phase.kind === "stopped"
          ? `Syncing stopped. ${phase.message}`
          : null;
    if (notice && notice !== this.told) this.options.notify(notice);
    if (notice) this.told = notice;
    else if (phase.kind === "open" || phase.kind === "unlinked")
      this.told = null;
    this.options.onChange();
  }

  private live(generation: number) {
    return generation === this.generation;
  }

  /** Opens the linked vault, if there is one the person confirmed. */
  async start() {
    if (this.linking) return;
    const generation = this.generation;
    try {
      const { custody } = this.options;
      const credentials = await custody.credentials.read();
      if (!this.live(generation)) return;
      if (!custody.seed() || !credentials) return this.unusable();
      if (custody.account()?.did !== credentials.did) {
        const account = await this.nameAccount(credentials.did);
        if (this.live(generation)) this.set({ kind: "confirm", account });
        return;
      }
      await this.open();
    } catch (error) {
      if (!this.live(generation)) return;
      this.close();
      this.set({ kind: "stopped", message: messageOf(error) });
    }
  }

  /**
   * Links this vault as a new device: shows the prompt through the phase,
   * waits for approval in the browser, then names the account it was bound
   * to. Nothing syncs until `confirm`.
   */
  async link(label: string, signal: AbortSignal): Promise<LinkedAccount> {
    const { custody, device } = this.options;
    if (this.linking || this.vault || custody.linked())
      throw new Error(ALREADY_LINKED);
    this.linking = true;
    let seed: Uint8Array | undefined;
    this.set({ kind: "linking" });
    try {
      // Whatever an earlier link left (an interrupted link, or tokens the secret store lost) goes before a new one starts.
      await this.forget();
      seed = device.createDeviceSeed();
      custody.saveSeed(seed);
      await device.linkDevice(seed, {
        ...this.deviceOptions(),
        label,
        signal,
        onPrompt: (prompt) => this.set({ kind: "linking", prompt }),
      });
      const credentials = await custody.credentials.read();
      if (!credentials) throw new Error("Linking stored no credentials.");
      const account = await this.nameAccount(credentials.did);
      this.set({ kind: "confirm", account });
      return account;
    } catch (error) {
      custody.wipe();
      if (this.phase.kind !== "removed") this.set({ kind: "unlinked" });
      throw error;
    } finally {
      this.linking = false;
      seed?.fill(0);
    }
  }

  /** The person recognised the account: remember it and start syncing. */
  async confirm() {
    if (this.phase.kind !== "confirm") return;
    this.options.custody.confirmAccount(this.phase.account);
    await this.open();
  }

  /** Stops syncing and forgets the seed, the tokens, the sync index and the device's local database; the files stay. */
  async unlink() {
    await this.forget();
    this.set({ kind: "unlinked" });
  }

  async syncNow() {
    if (this.phase.kind === "stopped") return this.start();
    const { vault, engine, generation } = this;
    if (!vault || !engine) return;
    engine.reconsiderDeletions();
    engine.remoteChanged();
    await this.pull(vault, generation);
    if (!this.ready) return;
    await this.round();
    // The round's writes would sync on their own; this sends them now.
    await vault.sync().catch(() => {});
  }

  /**
   * Syncs, and opens the gate for rounds once a sync has read the vault
   * from the PDS. Until one has, the device's copy may be empty or old, and
   * a round would read that as everything deleted. The device keeps syncing
   * on its own schedule, backing off when refused; `statusChanged` asks
   * again once one of those syncs goes through.
   */
  private pull(vault: DeviceVault, generation: number): Promise<void> {
    if (this.pulling) return this.pulling;
    // Started a tick later, so the statuses this sync publishes already see it running.
    const pulling: Promise<void> = Promise.resolve()
      .then(() => vault.sync())
      .catch(() => ({ read: false }))
      .then((report) => {
        if (this.live(generation) && report.read) this.ready = true;
      })
      .finally(() => {
        if (this.pulling === pulling) this.pulling = null;
      });
    this.pulling = pulling;
    return pulling;
  }

  localChanged() {
    this.schedule(LOCAL_DEBOUNCE_MS);
  }

  renamed(from: string, to: string) {
    this.engine?.renamed(from, to, this.options.updatesLinks());
    this.schedule(LOCAL_DEBOUNCE_MS);
  }

  /**
   * Closes the vault and stops any round or open in flight; unsynced writes
   * wait in the local database. The lock is released once the device has
   * stopped, so a token refresh it already sent lands before another
   * transport reads the store.
   */
  close() {
    this.generation++;
    this.ready = false;
    clearTimeout(this.timer);
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.engine?.stop();
    // An open still unlocking holds a transport too, maybe mid token refresh: it stops once it settles.
    const stopping =
      this.vault?.stop() ??
      this.unlocking?.then(
        (vault) => vault.stop(),
        () => {},
      );
    this.unlocking = null;
    this.pulling = null;
    if (stopping) {
      const earlier = this.stopped;
      this.stopped = within(Promise.all([earlier, stopping]), DRAIN_MS);
    }
    this.vault = null;
    this.engine = null;
    const release = this.release;
    this.release = null;
    if (release) {
      const earlier = this.released;
      this.released = Promise.all([earlier, this.stopped]).then(release);
    }
  }

  /**
   * Wipes the keys, the device's local databases and the sync index, whose
   * base those databases no longer back. Unsynced edits in them are dropped;
   * the files here still hold them.
   */
  private async forget() {
    const { custody, forgetIndexes, forgetDevice } = this.options;
    const seed = custody.seed();
    this.forgets++;
    this.close();
    custody.wipe();
    try {
      // The device's databases go only once nothing of it writes to them.
      await this.stopped;
      await forgetIndexes().catch(() => {});
      if (seed) await forgetDevice(seed).catch(() => {});
    } finally {
      seed?.fill(0);
    }
  }

  private deviceOptions(): DeviceOptions {
    const { custody, host, fetch } = this.options;
    return {
      host,
      fetch,
      ...custody.scope(),
      onRemoved: async (reason) => {
        // Called from inside the open that found the removal: waiting for that open would wait on itself, and its keys go now anyway.
        this.unlocking = null;
        await this.forget();
        this.set({ kind: "removed", message: REMOVED[reason] });
      },
    };
  }

  private open(): Promise<void> {
    this.opening ??= this.openOnce().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openOnce() {
    const { custody, device } = this.options;
    this.close();
    const generation = this.generation;
    const seed = custody.seed();
    try {
      const credentials = await custody.credentials.read();
      if (!this.live(generation)) return;
      if (!seed || !credentials) return this.unusable();
      if (custody.account()?.did !== credentials.did) return void this.start();
      this.set({ kind: "opening" });
      await this.released;
      if (!this.live(generation)) return;
      const release = await this.options.hold();
      if (!this.live(generation)) return release?.();
      if (!release)
        return this.set({ kind: "stopped", message: LOCKED_ELSEWHERE });
      this.release = release;
      const unlocking = device.openDeviceVault(seed, this.deviceOptions());
      this.unlocking = unlocking;
      const vault = await unlocking;
      if (!this.live(generation)) return;
      this.unlocking = null;
      // Held from here, so any close stops it before the lock goes.
      this.vault = vault;
      const checkpoint = await custody.checkpoints.read();
      if (!checkpoint) throw new Error("This vault's pin is missing.");
      const index = this.options.indexFor({
        did: credentials.did,
        vault: checkpoint.vault,
        deviceId: credentials.deviceId,
      });
      const forgets = this.forgets;
      const engine = new SyncEngine({
        local: this.options.local,
        remote: vault,
        // An engine still finishing a write after an unlink or removal saves nothing: its index is gone, and must stay gone.
        index: {
          load: () => index.load(),
          save: (entries) =>
            forgets === this.forgets ? index.save(entries) : Promise.resolve(),
        },
        configDir: this.options.configDir,
        confirmDeletions: this.options.confirmDeletions,
        stale: device.stale,
      });
      await engine.load();
      if (!this.live(generation)) return;
      if (vault.stranded) {
        engine.rebase();
        this.options.notify(STRANDED);
      }
      this.engine = engine;
      this.unsubscribe.push(
        vault.subscribe((status) => this.statusChanged(status)),
        vault.subscribeChanges(() => {
          this.engine?.remoteChanged();
          this.schedule(REMOTE_DEBOUNCE_MS);
        }),
        vault.subscribeTrustLoss((loss) => this.options.onTrustLoss(loss)),
      );
      if (this.phase.kind === "opening")
        this.set({ kind: "open", status: "Connecting" });
      // Pull first, so edits made here while closed meet the remote's as a conflict copy beside the note.
      void this.syncNow();
    } catch (error) {
      if (!this.live(generation)) return;
      this.close();
      if (this.phase.kind !== "removed")
        this.set({ kind: "stopped", message: messageOf(error) });
    } finally {
      seed?.fill(0);
    }
  }

  private statusChanged(status: string) {
    if (status === this.options.device.locked) {
      // Locked means access changed and the keys are gone: opening again learns whether the device was removed.
      this.close();
      void this.open();
      return;
    }
    // The device syncs on its own schedule, backing off when refused: once one of its syncs has read the vault, one sync of ours learns so.
    if (!this.ready && !this.pulling && this.options.device.followsRead(status))
      void this.syncNow();
    if (this.phase.kind === "open") this.set({ kind: "open", status });
  }

  private schedule(delay: number) {
    if (!this.engine) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.round(), delay);
  }

  private async round() {
    const { engine, vault, generation } = this;
    if (!engine || !vault || !this.ready) return;
    try {
      this.lastRound = await engine.run();
      if (!this.live(generation)) return;
      if (this.lastRound.applied) void vault.sync().catch(() => {});
      if (this.lastRound.failed.length) this.schedule(RETRY_MS);
    } catch (error) {
      if (!this.live(generation)) return;
      this.lastRound = {
        applied: 0,
        failed: [{ path: "", error: messageOf(error) }],
        unsyncable: [],
        held: { local: 0, remote: 0 },
      };
      this.schedule(RETRY_MS);
    }
    this.options.onChange();
  }
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
