import type { PadRecord, PadStorage } from "./outbox";

const DB_NAME = "judge-pad";
const STORE = "pads";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** IndexedDB-backed storage for the outbox: one record per match, keyed by match id. */
export function idbStorage(factory: IDBFactory = indexedDB): PadStorage {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "matchId" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opening;
  };
  const store = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);

  return {
    all: async () => request((await store("readonly")).getAll() as IDBRequest<PadRecord[]>),
    put: async (record) => void (await request((await store("readwrite")).put(record))),
    delete: async (matchId) => void (await request((await store("readwrite")).delete(matchId))),
  };
}

/** Used when IndexedDB is unavailable (some private modes): the pad still works, just not across reloads. */
export function memoryStorage(): PadStorage {
  const rows = new Map<string, PadRecord>();
  return {
    all: async () => [...rows.values()],
    put: async (record) => void rows.set(record.matchId, record),
    delete: async (matchId) => void rows.delete(matchId),
  };
}
