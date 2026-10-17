import { describe, expect, it } from "vitest";
import type { BattleOp, PadBattle } from "@/lib/battles";
import type { SubmitOutcome } from "@/lib/tournament/results";
import { applyQueue, PadOutbox, type PadRecord, type PadStorage, type PadTransport, type TransportFailure } from "@/lib/offline/outbox";

const M = "match-1";
let nextId = 0;
const add = (kind: "spin" | "xtreme" | "draw", side: 1 | 2 | null): BattleOp => ({ op: "add", opId: `op-${++nextId}`, kind, side });

function memoryStorage(initial: PadRecord[] = []): PadStorage & { rows: Map<string, PadRecord> } {
  const rows = new Map(initial.map((r) => [r.matchId, r]));
  return {
    rows,
    all: async () => structuredClone([...rows.values()]),
    put: async (r) => void rows.set(r.matchId, structuredClone(r)),
    delete: async (id) => void rows.delete(id),
  };
}

/** A server that applies ops for real (so acks look like production) and can be taken offline. */
function fakeServer() {
  const state = {
    battles: [] as PadBattle[],
    fail: null as TransportFailure["reason"] | null,
    time: 1_000,
    opCalls: [] as BattleOp[][],
    submits: [] as boolean[],
    outcome: { status: "synced" } as SubmitOutcome,
    /** Refuse "Start match" with this reason (the stadium has no judge). */
    refuseStart: null as string | null,
  };
  const transport: PadTransport = {
    async sendOps(_matchId, ops) {
      if (state.fail) return { ok: false, reason: state.fail };
      state.opCalls.push(ops);
      // Like the real server: while the match isn't started, nothing after a refused start counts.
      const refused = state.refuseStart ? ops.filter((op) => op.op === "start") : [];
      const accepted = refused.length ? [] : ops;
      state.battles = applyQueue(state.battles, accepted);
      const rejected = [
        ...refused.map((op) => ({ opId: op.opId, reason: state.refuseStart! })),
        ...(refused.length ? ops.filter((op) => op.op === "add").map((op) => ({ opId: op.opId, reason: "Start the match before scoring." })) : []),
      ];
      return { ok: true, battles: state.battles, serverTime: ++state.time, rejected };
    },
    async submit(_matchId, confirm) {
      if (state.fail) return { ok: false, reason: state.fail };
      state.submits.push(confirm);
      return { ok: true, outcome: state.outcome };
    },
  };
  return { state, transport };
}

const seed = { tournamentId: "t1", label: "Winners R1 · A: Alex vs Sam", battles: [] as PadBattle[], renderedAt: 500, started: true };

async function setup(storage = memoryStorage()) {
  const server = fakeServer();
  const outbox = new PadOutbox(storage, server.transport, () => 10_000);
  await outbox.open(M, seed);
  return { outbox, storage, server: server.state };
}

describe("PadOutbox online", () => {
  it("sends a tap and keeps the server's confirmed list", async () => {
    const { outbox, server } = await setup();
    await outbox.enqueue(M, add("xtreme", 1));
    await outbox.flush();
    expect(server.battles.map((b) => b.kind)).toEqual(["xtreme"]);
    expect(outbox.snapshot(M)).toMatchObject({ queue: [], ackedAt: 1_001, touched: true });
    expect(outbox.battles(M)).toHaveLength(1);
    expect(outbox.online).toBe(true);
  });

  it("batches taps made while a send is in flight", async () => {
    const { outbox, server } = await setup();
    await Promise.all([outbox.enqueue(M, add("spin", 1)), outbox.enqueue(M, add("spin", 2)), outbox.enqueue(M, add("spin", 1))]);
    await outbox.flush();
    expect(server.battles).toHaveLength(3);
    expect(server.opCalls.flat()).toHaveLength(3);
    expect(outbox.snapshot(M)!.queue).toEqual([]);
  });
});

describe("PadOutbox offline", () => {
  it("keeps taps on the device and shows them immediately", async () => {
    const { outbox, server, storage } = await setup();
    server.fail = "network";
    await outbox.enqueue(M, add("xtreme", 1));
    await outbox.enqueue(M, add("spin", 2));
    await outbox.flush();

    expect(outbox.online).toBe(false);
    expect(outbox.battles(M).map((b) => b.kind)).toEqual(["xtreme", "spin"]);
    expect(storage.rows.get(M)!.queue).toHaveLength(2);
    expect(server.battles).toEqual([]);
  });

  it("survives a reload: a new outbox on the same storage still has the taps and syncs them later", async () => {
    const storage = memoryStorage();
    const first = await setup(storage);
    first.server.fail = "network";
    await first.outbox.enqueue(M, add("xtreme", 1));
    await first.outbox.enqueue(M, add("spin", 1));
    await first.outbox.flush();

    // The tablet reloads while still offline; the cached page is older than what we know.
    const server = fakeServer();
    server.state.fail = "network";
    const reloaded = new PadOutbox(storage, server.transport, () => 20_000);
    await reloaded.open(M, { ...seed, renderedAt: 400 });
    expect(reloaded.battles(M).map((b) => b.kind)).toEqual(["xtreme", "spin"]);

    server.state.fail = null;
    await reloaded.flush();
    expect(server.state.battles.map((b) => b.kind)).toEqual(["xtreme", "spin"]);
    expect(reloaded.snapshot(M)!.queue).toEqual([]);
    expect(reloaded.online).toBe(true);
  });

  it("resending after a lost response doesn't duplicate (same op ids go out again)", async () => {
    const { outbox, server } = await setup();
    const op = add("xtreme", 1);
    // The server applied it but the response never arrived.
    server.battles = applyQueue([], [op]);
    server.fail = "network";
    await outbox.enqueue(M, op);
    await outbox.flush();
    server.fail = null;
    await outbox.flush();
    expect(server.battles).toHaveLength(1);
    expect(outbox.battles(M)).toHaveLength(1);
  });

  it("undo of a tap that never left the device needs no server call", async () => {
    const { outbox, server } = await setup();
    server.fail = "network";
    await outbox.enqueue(M, add("spin", 1));
    await outbox.flush();
    await outbox.undoLast(M, "void-1");
    expect(outbox.snapshot(M)!.queue).toEqual([]);
    expect(outbox.battles(M)).toEqual([]);
  });

  it("undo of a confirmed battle queues a void", async () => {
    const { outbox, server } = await setup();
    await outbox.enqueue(M, add("spin", 1));
    await outbox.flush();
    server.fail = "network";
    await outbox.undoLast(M, "void-1");
    await outbox.flush();
    expect(outbox.battles(M)).toEqual([]);
    expect(outbox.snapshot(M)!.queue).toMatchObject([{ op: "void" }]);
    server.fail = null;
    await outbox.flush();
    expect(server.battles).toEqual([]);
  });
});

describe("PadOutbox results", () => {
  it("sends the result only after the queued taps are confirmed", async () => {
    const { outbox, server } = await setup();
    server.fail = "network";
    await outbox.enqueue(M, add("xtreme", 1));
    await outbox.requestSubmit(M, false);
    await outbox.flush();
    expect(server.submits).toEqual([]);
    expect(outbox.snapshot(M)).toMatchObject({ submit: { confirmDestructive: false } });

    server.fail = null;
    await outbox.flush();
    expect(server.opCalls).toHaveLength(1);
    expect(server.submits).toEqual([false]);
    expect(outbox.snapshot(M)).toMatchObject({ submit: null, result: {}, touched: false, problem: null });
  });

  it("surfaces a correction that needs confirmation, then sends it confirmed", async () => {
    const { outbox, server } = await setup();
    server.outcome = { status: "needs_confirmation", affected: ["Winners R2 · I (4 - 1)"] };
    await outbox.requestSubmit(M, false);
    await outbox.flush();
    expect(outbox.snapshot(M)).toMatchObject({ submit: null, problem: { kind: "needs_confirmation", affected: ["Winners R2 · I (4 - 1)"] } });

    server.outcome = { status: "synced" };
    await outbox.requestSubmit(M, true);
    await outbox.flush();
    expect(server.submits).toEqual([false, true]);
    expect(outbox.snapshot(M)!.result).not.toBeNull();
  });

  it("keeps a refused result as a problem instead of retrying forever", async () => {
    const { outbox, server } = await setup();
    server.outcome = { status: "failed", error: "The server is unavailable." };
    await outbox.requestSubmit(M, false);
    await outbox.flush();
    await outbox.flush();
    expect(server.submits).toHaveLength(1);
    expect(outbox.snapshot(M)).toMatchObject({ problem: { kind: "error", message: "The server is unavailable." } });
  });

  it("an edit after submitting withdraws the pending submission", async () => {
    const { outbox, server } = await setup();
    server.fail = "network";
    await outbox.requestSubmit(M, false);
    await outbox.enqueue(M, add("spin", 2));
    expect(outbox.snapshot(M)!.submit).toBeNull();
  });
});

describe("PadOutbox account problems", () => {
  it("keeps the work and flags signed-out, then syncs after signing in again", async () => {
    const { outbox, server } = await setup();
    server.fail = "signed_out";
    await outbox.enqueue(M, add("spin", 1));
    await outbox.flush();
    expect(outbox.snapshot(M)).toMatchObject({ problem: { kind: "signed_out" } });
    expect(outbox.snapshot(M)!.queue).toHaveLength(1);
    expect(outbox.online).toBe(true);

    server.fail = null;
    await outbox.flush();
    expect(outbox.snapshot(M)).toMatchObject({ queue: [], problem: null });
  });

  it("stops retrying a match the signed-in organizer doesn't own, until it's discarded", async () => {
    const { outbox, server, storage } = await setup();
    server.fail = "not_found";
    await outbox.enqueue(M, add("spin", 1));
    await outbox.flush();
    server.fail = null;
    await outbox.flush();
    expect(server.opCalls).toEqual([]);
    expect(outbox.all()).toHaveLength(1);

    await outbox.discard(M);
    expect(outbox.all()).toEqual([]);
    expect(storage.rows.size).toBe(0);
  });
});

describe("PadOutbox housekeeping", () => {
  it("takes the page's battles when the page is newer than our last confirmation", async () => {
    const { outbox } = await setup();
    const fresh: PadBattle[] = [{ opId: "server-1", kind: "over", side: 2 }];
    await outbox.open(M, { ...seed, battles: fresh, renderedAt: 9_999 });
    expect(outbox.battles(M)).toEqual(fresh);
  });

  it("drops day-old records with nothing left to send, keeps ones with unsent work", async () => {
    const old = (matchId: string, queue: BattleOp[]): PadRecord => ({
      matchId, tournamentId: "t", label: "x", acked: [], ackedAt: 0, queue, submit: null, problem: null, result: null, notice: null, syncedAt: null, touched: false, updatedAt: 0,
    });
    const storage = memoryStorage([old("done", []), old("pending", [add("spin", 1)])]);
    const outbox = new PadOutbox(storage, fakeServer().transport, () => 2 * 24 * 60 * 60 * 1000);
    await outbox.init();
    expect(outbox.all().map((r) => r.matchId)).toEqual(["pending"]);
    expect([...storage.rows.keys()]).toEqual(["pending"]);
  });

  it("notifies subscribers and keeps a stable list reference between changes", async () => {
    const { outbox } = await setup();
    let calls = 0;
    const unsubscribe = outbox.subscribe(() => calls++);
    const before = outbox.all();
    expect(outbox.all()).toBe(before);
    await outbox.enqueue(M, add("spin", 1));
    expect(calls).toBeGreaterThan(0);
    expect(outbox.all()).not.toBe(before);
    unsubscribe();
  });
});

describe("PadOutbox starting a match", () => {
  const called = { ...seed, started: false };
  const startOp = (queue: BattleOp[]) => queue.filter((op) => op.op === "start");

  async function calledMatch(storage = memoryStorage()) {
    const server = fakeServer();
    const outbox = new PadOutbox(storage, server.transport, () => 10_000);
    await outbox.open(M, called);
    return { outbox, storage, server: server.state };
  }

  it("opens a called match locked, and a match already being played unlocked", async () => {
    expect((await calledMatch()).outbox.snapshot(M)!.started).toBe(false);
    expect((await setup()).outbox.snapshot(M)!.started).toBe(true);
  });

  it("unlocks at once and tells the server", async () => {
    const { outbox, server } = await calledMatch();
    await outbox.start(M, "start-1");
    expect(outbox.snapshot(M)!.started).toBe(true);
    await outbox.flush();
    expect(server.opCalls).toEqual([[{ op: "start", opId: "start-1" }]]);
    expect(outbox.snapshot(M)).toMatchObject({ started: true, queue: [], notice: null });
  });

  it("is not a battle: it leaves the score and the 'edited' flag alone", async () => {
    const { outbox } = await calledMatch();
    await outbox.start(M, "start-1");
    expect(outbox.battles(M)).toEqual([]);
    expect(outbox.snapshot(M)!.touched).toBe(false);
    expect(applyQueue([], [{ op: "start", opId: "s" }, add("spin", 1)])).toHaveLength(1);
  });

  it("works offline: Start and the taps after it are kept in order and sent together later", async () => {
    const storage = memoryStorage();
    const { outbox, server } = await calledMatch(storage);
    server.fail = "network";
    await outbox.start(M, "start-1");
    await outbox.enqueue(M, add("xtreme", 1));
    await outbox.flush();
    expect(outbox.snapshot(M)).toMatchObject({ started: true });
    expect(storage.rows.get(M)!.queue.map((op) => op.op)).toEqual(["start", "add"]);

    // A reload while offline: the cached page still says "called", but the Start is on the device.
    const reloaded = new PadOutbox(storage, fakeServer().transport, () => 10_000);
    await reloaded.open(M, { ...called, renderedAt: 400 });
    expect(reloaded.snapshot(M)!.started).toBe(true);

    server.fail = null;
    await outbox.flush();
    expect(server.opCalls.at(-1)!.map((op) => op.op)).toEqual(["start", "add"]);
    expect(server.battles.map((b) => b.kind)).toEqual(["xtreme"]);
  });

  it("locks again and says why when the server refuses the start", async () => {
    const { outbox, server } = await calledMatch();
    server.refuseStart = "This stadium has no judge yet.";
    await outbox.start(M, "start-1");
    await outbox.flush();
    expect(outbox.snapshot(M)).toMatchObject({ started: false, queue: [], notice: "This stadium has no judge yet." });
  });

  it("trusts a fresh page over what it remembered, unless a Start is still waiting here", async () => {
    const { outbox, server } = await calledMatch();
    await outbox.start(M, "start-1");
    await outbox.flush();
    // The organizer held the match and it was called again: the new page says "not started".
    await outbox.open(M, { ...called, renderedAt: 99_999 });
    expect(outbox.snapshot(M)!.started).toBe(false);

    server.fail = "network";
    await outbox.start(M, "start-2");
    await outbox.flush();
    await outbox.open(M, { ...called, renderedAt: 199_999 });
    expect(outbox.snapshot(M)!.started).toBe(true);
    expect(startOp(outbox.snapshot(M)!.queue)).toHaveLength(1);
  });
});
