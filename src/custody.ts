import type { LinkedAccount } from "./account";
import type {
  DeviceCheckpoint,
  DeviceCheckpointStore,
  NoteDeviceCredentialStore,
  NoteDeviceCredentials,
} from "./device";

/**
 * A string store outside the vault folder. In Obsidian this is its secret
 * storage: on desktop encrypted with the OS keychain (Electron `safeStorage`),
 * on mobile the platform's secure storage.
 */
export interface SecretBackend {
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}
function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function parsed(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asCredentials(value: unknown): NoteDeviceCredentials | null {
  if (!isRecord(value)) return null;
  const { accessToken, refreshToken, deviceId, userId, did, accessExpiresAt } =
    value;
  return typeof accessToken === "string" &&
    typeof refreshToken === "string" &&
    typeof deviceId === "string" &&
    typeof userId === "string" &&
    typeof did === "string" &&
    did.startsWith("did:") &&
    typeof accessExpiresAt === "number"
    ? { accessToken, refreshToken, deviceId, userId, did, accessExpiresAt }
    : null;
}
function asCheckpoint(value: unknown): DeviceCheckpoint | null {
  return isRecord(value) &&
    typeof value.vault === "string" &&
    typeof value.epoch === "number" &&
    isRecord(value.pinned) &&
    typeof value.trust === "string" &&
    Array.isArray(value.runners)
    ? (value as unknown as DeviceCheckpoint)
    : null;
}

/**
 * Everything a linked device keeps: its seed, Flow ID device tokens, the pin
 * it accepted and the account the person confirmed, each a secret under this
 * vault's own namespace. Obsidian's mobile secret storage is shared by every
 * vault on the device, so the namespace keeps two vaults' links apart.
 */
export class Custody {
  readonly credentials: NoteDeviceCredentialStore;
  readonly checkpoints: DeviceCheckpointStore;
  private readonly ids: Record<
    "seed" | "credentials" | "checkpoint" | "account",
    string
  >;
  private generation = 0;

  constructor(
    private readonly backend: SecretBackend,
    namespace: string,
  ) {
    if (!/^[a-z0-9]{8,32}$/u.test(namespace))
      throw new Error("Invalid custody namespace");
    const id = (name: string) => `flow-note-${namespace}-${name}`;
    this.ids = {
      seed: id("seed"),
      credentials: id("tokens"),
      checkpoint: id("pin"),
      account: id("account"),
    };
    this.credentials = {
      read: async () =>
        asCredentials(parsed(this.backend.get(this.ids.credentials))),
      write: async (credentials) => {
        if (!asCredentials(credentials))
          throw new Error("Invalid device credentials");
        this.backend.set(this.ids.credentials, JSON.stringify(credentials));
      },
    };
    this.checkpoints = {
      read: async () =>
        asCheckpoint(parsed(this.backend.get(this.ids.checkpoint))),
      write: async (checkpoint) => {
        this.backend.set(this.ids.checkpoint, JSON.stringify(checkpoint));
      },
    };
  }

  /**
   * The stores to hand one device transport. A refresh that lands after
   * `wipe` (an unlink or a removal mid-refresh) writes nothing, so wiped
   * tokens stay wiped and a stale session can't overwrite a newer pin.
   */
  scope(): Pick<Custody, "credentials" | "checkpoints"> {
    const generation = this.generation;
    const current = () => generation === this.generation;
    return {
      credentials: {
        read: () => this.credentials.read(),
        write: async (value) => {
          if (current()) await this.credentials.write(value);
        },
      },
      checkpoints: {
        read: () => this.checkpoints.read(),
        write: async (value) => {
          if (current()) await this.checkpoints.write(value);
        },
      },
    };
  }

  seed(): Uint8Array | null {
    const text = this.backend.get(this.ids.seed);
    if (!text) return null;
    try {
      const seed = fromBase64Url(text);
      return seed.length === 32 ? seed : null;
    } catch {
      return null;
    }
  }

  saveSeed(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("Invalid device seed");
    this.backend.set(this.ids.seed, toBase64Url(seed));
  }

  /** Whether a link's tokens are stored, whether or not its account was confirmed. */
  linked(): boolean {
    return (
      asCredentials(parsed(this.backend.get(this.ids.credentials))) !== null
    );
  }

  /** The account the person confirmed this vault syncs with; nothing uploads before it is set. */
  account(): LinkedAccount | null {
    const value = parsed(this.backend.get(this.ids.account));
    if (!isRecord(value) || typeof value.did !== "string") return null;
    return typeof value.handle === "string"
      ? { did: value.did, handle: value.handle }
      : { did: value.did };
  }

  confirmAccount(account: LinkedAccount) {
    this.backend.set(this.ids.account, JSON.stringify(account));
  }

  /**
   * Forgets the seed, the tokens and the confirmed account. The pin stays, as
   * the device client asks, so a later link can't be walked back to an older
   * access statement; it is public and opens nothing.
   */
  wipe() {
    this.generation++;
    this.backend.delete(this.ids.seed);
    this.backend.delete(this.ids.credentials);
    this.backend.delete(this.ids.account);
  }
}
