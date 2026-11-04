import type { SyncIndex } from "./engine";
import type { Entry } from "./plan";

const STORE = "index";
const KEY = "entries";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
      const value = await request(
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
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }

  async clear(): Promise<void> {
    await request(this.factory.deleteDatabase(this.name));
  }
}
