import { httpTransport } from "./http-transport";
import { idbStorage, memoryStorage } from "./idb-storage";
import { PadOutbox } from "./outbox";

let instance: PadOutbox | null = null;

/** The one outbox for this browser tab. */
export function getOutbox(): PadOutbox {
  if (!instance) {
    let storage;
    try {
      storage = typeof indexedDB === "undefined" ? memoryStorage() : idbStorage();
    } catch {
      storage = memoryStorage();
    }
    instance = new PadOutbox(storage, httpTransport);
  }
  return instance;
}

/**
 * Flushes with a cross-tab lock where available, so two tabs open on the same tablet
 * don't send the same queue at the same moment (it would be harmless, just wasteful).
 */
export async function flushOutbox(): Promise<void> {
  const outbox = getOutbox();
  if (typeof navigator !== "undefined" && navigator.locks) {
    await navigator.locks.request("judge-pad-outbox", { ifAvailable: true }, async (lock) => {
      if (lock) await outbox.flush();
    });
    return;
  }
  await outbox.flush();
}

// crypto.randomUUID needs a secure context; tablets on a LAN address over http don't have one.
export function uuid(): string {
  if (typeof crypto.randomUUID === "function" && window.isSecureContext) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
