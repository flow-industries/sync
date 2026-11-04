import { type LinkedAccount, linkedAccount, type ResolveTxt } from "./account";
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
import { Traffic } from "./traffic";

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
  /** Whether a status means the device's last sync read the vault, so its local copy is current. */
  pulled: (status: string) => boolean;
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

export interface ControllerOptions {
  custody: Custody;
  device: DeviceClient;
  /** Flow ID's origin. */
  host: string;
  fetch: NoteDeviceFetch;
  /** DNS TXT lookups, for handles verified that way; absent where the platform has none. */
  resolveTxt?: ResolveTxt;
  local: LocalVault;
  configDir: string;
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
/** How long a closed device's lock waits for a token refresh it already sent. */
const DRAIN_MS = 15_000;

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
  private traffic = new Traffic();
  /** Settles once the last closed device's lock is released. */
  private released: Promise<void> = Promise.resolve();
  /** The last stop or removal told to the person, so a retry that fails the same way stays quiet. */
  private told: string | null = null;

  constructor(private readonly options: ControllerOptions) {}

  private nameAccount(did: string) {
    return linkedAccount(did, this.options.fetch, this.options.resolveTxt);
  }

  /** The account the person confirmed, while linked. */
  account(): LinkedAccount | null {
    return this.options.custody.account();
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
      if (!custody.seed() || !credentials)
        return this.set({ kind: "unlinked" });
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
    const { vault, engine } = this;
    if (!vault || !engine) return;
    engine.reconsiderDeletions();
    engine.remoteChanged();
    await vault.sync().catch(() => {});
    await this.round();
    // The round's writes would sync on their own; this sends them now.
    await vault.sync().catch(() => {});
  }

  localChanged() {
    this.schedule(LOCAL_DEBOUNCE_MS);
  }

  renamed(from: string, to: string) {
    this.engine?.renamed(from, to);
    this.schedule(LOCAL_DEBOUNCE_MS);
  }

  /**
   * Closes the vault and stops any round or open in flight; unsynced writes
   * wait in the local database. The lock is released once the device's
   * requests settle, so a token refresh it already sent lands first.
   */
  close() {
    this.generation++;
    this.ready = false;
    clearTimeout(this.timer);
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    this.engine?.stop();
    this.vault?.stop();
    this.vault = null;
    this.engine = null;
    const release = this.release;
    this.release = null;
    if (release) {
      const earlier = this.released;
      this.released = this.traffic
        .idle(DRAIN_MS)
        .then(() => earlier)
        .then(release);
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
    this.close();
    custody.wipe();
    try {
      await forgetIndexes().catch(() => {});
      if (seed) await forgetDevice(seed).catch(() => {});
    } finally {
      seed?.fill(0);
    }
  }

  /** Options for one device transport, whose requests and token writes count toward its traffic. */
  private deviceOptions(): DeviceOptions {
    const { custody, host, fetch } = this.options;
    const traffic = this.traffic;
    const { credentials, checkpoints } = custody.scope();
    return {
      host,
      fetch: (url, init) => traffic.track(() => fetch(url, init)),
      credentials: {
        read: credentials.read,
        write: (value) => traffic.track(() => credentials.write(value)),
      },
      checkpoints,
      onRemoved: async (reason) => {
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
    let vault: DeviceVault | undefined;
    try {
      const credentials = await custody.credentials.read();
      if (!this.live(generation)) return;
      if (!seed || !credentials) return this.set({ kind: "unlinked" });
      if (custody.account()?.did !== credentials.did) return void this.start();
      this.set({ kind: "opening" });
      await this.released;
      if (!this.live(generation)) return;
      const release = await this.options.hold();
      if (!this.live(generation)) return release?.();
      if (!release)
        return this.set({ kind: "stopped", message: LOCKED_ELSEWHERE });
      this.release = release;
      this.traffic = new Traffic();
      vault = await device.openDeviceVault(seed, this.deviceOptions());
      const checkpoint = await custody.checkpoints.read();
      if (!checkpoint) throw new Error("This vault's pin is missing.");
      const engine = new SyncEngine({
        local: this.options.local,
        remote: vault,
        index: this.options.indexFor({
          did: credentials.did,
          vault: checkpoint.vault,
          deviceId: credentials.deviceId,
        }),
        configDir: this.options.configDir,
        confirmDeletions: this.options.confirmDeletions,
        stale: device.stale,
      });
      await engine.load();
      if (!this.live(generation)) return vault.stop();
      if (vault.stranded) {
        engine.rebase();
        this.options.notify(STRANDED);
      }
      this.vault = vault;
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
      if (!this.live(generation)) return vault?.stop();
      this.close();
      vault?.stop();
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
    if (!this.ready && this.options.device.pulled(status)) {
      this.ready = true;
      this.schedule(0);
    }
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
