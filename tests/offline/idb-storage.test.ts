import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { idbStorage } from "@/lib/offline/idb-storage";
import { PadOutbox, type PadRecord, type PadTransport } from "@/lib/offline/outbox";

const record = (matchId: string, extra: Partial<PadRecord> = {}): PadRecord => ({
  matchId,
  tournamentId: "t1",
  label: "Winners R1 · A: Alex vs Sam",
  acked: [{ opId: "a", kind: "xtreme", side: 1 }],
  ackedAt: 1,
  queue: [{ op: "add", opId: "b", kind: "spin", side: 2 }],
  submit: null,
  problem: null,
  result: null,
  notice: null,
  syncedAt: null,
  touched: true,
  updatedAt: 1,
  ...extra,
});

describe("idbStorage", () => {
  it("stores, replaces, lists and deletes records by match id", async () => {
    const storage = idbStorage(new IDBFactory());
    await storage.put(record("m1"));
    await storage.put(record("m2"));
    await storage.put(record("m1", { label: "updated" }));

    const all = await storage.all();
    expect(all.map((r) => r.matchId).sort()).toEqual(["m1", "m2"]);
    expect(all.find((r) => r.matchId === "m1")).toMatchObject({ label: "updated", queue: [{ opId: "b" }] });

    await storage.delete("m1");
    expect((await storage.all()).map((r) => r.matchId)).toEqual(["m2"]);
  });

  it("keeps data across a reopen of the same database (a page reload)", async () => {
    const factory = new IDBFactory();
    await idbStorage(factory).put(record("m1"));
    expect(await idbStorage(factory).all()).toHaveLength(1);
  });

  it("works as the outbox's storage end to end", async () => {
    const factory = new IDBFactory();
    const offline: PadTransport = {
      sendOps: async () => ({ ok: false, reason: "network" }),
      submit: async () => ({ ok: false, reason: "network" }),
    };
    const first = new PadOutbox(idbStorage(factory), offline);
    await first.open("m1", { tournamentId: "t1", label: "A", battles: [], renderedAt: 1, started: true });
    await first.enqueue("m1", { op: "add", opId: "x", kind: "burst", side: 1 });
    await first.flush();

    const afterReload = new PadOutbox(idbStorage(factory), offline);
    await afterReload.init();
    expect(afterReload.battles("m1")).toEqual([{ opId: "x", kind: "burst", side: 1 }]);
    expect(afterReload.hasWork()).toBe(true);
  });
});
