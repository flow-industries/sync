import type { SyncIndex } from "./engine";
import type { Entry } from "./plan";

const STORE = "index";
const KEY = "entries";

const failure = (error: DOMException | null) =>
  error ?? new Error("IndexedDB request failed");

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(failure(req.error));
  });
}

const PREFIX = "flow-note-sync";

/** Which link an index belongs to: a new link is a new device, with a base of its own. */
export interface IndexKey {
  did: string;
  vault: string;
  deviceId: string;
}

/** The database name of one linked device's index, under this Obsidian vault's namespace. */
export const indexName = (
  namespace: string,
  { did, vault, deviceId }: IndexKey,
) => `${PREFIX}:${namespace}:${did}:${vault}:${deviceId}`;

/**
 * Deletes every index this Obsidian vault holds, for each device it was ever
 * linked as, so no later link can plan against a base its device never had.
 */
export async function deleteIndexes(
  namespace: string,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const prefix = `${PREFIX}:${namespace}:`;
  for (const { name } of await factory.databases())
    if (name?.startsWith(prefix)) await request(factory.deleteDatabase(name));
}

/**
 * The sync index in this app's IndexedDB, one database per linked device:
 * outside the vault folder, so git or another sync tool never copies it to a
 * machine where it would describe a different link.
 */
export class IndexedDbIndex implements SyncIndex {
  constructor(
    private readonly name: string,
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private async open(): Promise<IDBDatabase> {
    const req = this.factory.open(this.name, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    return request(req);
  }

  async load(): Promise<Entry[]> {
    const db = await this.open();
    try {
      const value = await request<unknown>(
        db.transaction(STORE).objectStore(STORE).get(KEY),
      );
      return Array.isArray(value) ? (value as Entry[]) : [];
    } finally {
      db.close();
    }
  }

  async save(entries: Entry[]): Promise<void> {
    const db = await this.open();
    try {
      const transaction = db.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(entries, KEY);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(failure(transaction.error));
        transaction.onabort = () => reject(failure(transaction.error));
      });
    } finally {
      db.close();
    }
  }
}
