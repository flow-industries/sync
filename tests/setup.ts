// The device client keeps its local database in IndexedDB, which Bun lacks; it must exist before Dexie loads.
import "fake-indexeddb/auto";
