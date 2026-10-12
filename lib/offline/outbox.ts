// The judge pad's offline outbox. Framework-free and dependency-injected (storage, transport,
// clock) so it can be unit-tested; the browser wiring lives in ./client.ts.
//
// Per match it keeps: the battles the server last confirmed, the operations not yet confirmed,
// and optionally an intent to send the result. Everything is persisted on every change, so a
// reload or a crashed tab while offline loses nothing.

import type { BattleOp, PadBattle } from "@/lib/battles";
import type { SubmitOutcome } from "@/lib/challonge/report";

export type PadProblem =
  | { kind: "needs_confirmation"; affected: string[] }
  | { kind: "error"; message: string }
  | { kind: "signed_out" }
  | { kind: "not_found" };

export type PadRecord = {
  matchId: string;
  tournamentId: string;
  /** For banners outside the pad, e.g. "Winners R1 · A: Alex vs Sam". */
  label: string;
  /** Battles as last confirmed by the server, and the server time of that confirmation. */
  acked: PadBattle[];
  ackedAt: number;
  queue: BattleOp[];
  /** Send the result as soon as the queue is empty and the server is reachable. */
  submit: { confirmDestructive: boolean } | null;
  problem: PadProblem | null;
  /** Set when the result reached Challonge; cleared by the next edit. */
  result: { warning?: string } | null;
  /** A battle the server refused (e.g. tapped after the match was decided on another device). */
  notice: string | null;
  /** When this device last got a result onto Challonge for this match. */
  syncedAt: number | null;
  /** True once battles changed since the last synced result. */
  touched: boolean;
  /**
   * Whether scoring is unlocked: the match was already being played when the pad opened, or
   * "Start match" was pressed here. Missing on records saved before starting existed.
   */
  started?: boolean;
  updatedAt: number;
};

export type TransportFailure = { ok: false; reason: "network" | "signed_out" | "not_found" | "server"; message?: string };

export interface PadTransport {
  sendOps(
    matchId: string,
    ops: BattleOp[],
  ): Promise<{ ok: true; battles: PadBattle[]; serverTime: number; rejected: { opId: string; reason: string }[] } | TransportFailure>;
  submit(matchId: string, confirmDestructive: boolean): Promise<{ ok: true; outcome: SubmitOutcome } | TransportFailure>;
}

export interface PadStorage {
  all(): Promise<PadRecord[]>;
  put(record: PadRecord): Promise<void>;
  delete(matchId: string): Promise<void>;
}

export type PadSeed = {
  tournamentId: string;
  label: string;
  battles: PadBattle[];
  renderedAt: number;
  /** False for a match that was called and still has to be started. */
  started: boolean;
};

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function applyQueue(base: PadBattle[], queue: BattleOp[]): PadBattle[] {
  let list = base;
  for (const op of queue) {
    if (op.op === "add") {
      if (!list.some((b) => b.opId === op.opId)) {
        list = [...list, { opId: op.opId, kind: op.kind, side: op.kind === "draw" ? null : op.side }];
      }
    } else if (op.op === "void") {
      list = list.filter((b) => b.opId !== op.targetOpId);
    }
    // "start" changes the match's status, not its battles.
  }
  return list;
}

export const needsWork = (r: PadRecord) => r.queue.length > 0 || r.submit !== null;
/** Has something the organizer should know about: unsent work, or a send that didn't go through. */
export const needsAttention = (r: PadRecord) => needsWork(r) || r.problem !== null;

export class PadOutbox {
  private records = new Map<string, PadRecord>();
  private listeners = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private again = false;
  private inFlight = new Set<string>();
  private list: PadRecord[] = [];
  /** Whether the last attempt to reach the server worked. */
  online = true;

  constructor(
    private readonly storage: PadStorage,
    private readonly transport: PadTransport,
    private readonly now: () => number = Date.now,
  ) {}

  /** Loads persisted records once; drops day-old ones that have nothing left to send. */
  init(): Promise<void> {
    this.loaded ??= (async () => {
      for (const record of await this.storage.all()) {
        if (!needsWork(record) && !record.problem && this.now() - record.updatedAt > STALE_AFTER_MS) {
          await this.storage.delete(record.matchId);
        } else {
          this.records.set(record.matchId, record);
        }
      }
      this.emit();
    })();
    return this.loaded;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (matchId: string): PadRecord | undefined => this.records.get(matchId);
  /** Stable array reference between changes (for useSyncExternalStore). */
  all = (): PadRecord[] => this.list;
  hasWork = () => this.list.some(needsWork);

  private emit() {
    this.list = [...this.records.values()];
    this.listeners.forEach((l) => l());
  }

  private async save(matchId: string, change: (record: PadRecord) => Partial<PadRecord>) {
    const record = this.records.get(matchId);
    if (!record) return;
    const next = { ...record, ...change(record), updatedAt: this.now() };
    this.records.set(matchId, next);
    this.emit();
    await this.storage.put(next);
  }

  /**
   * Called when a pad opens. The page's battles replace ours only if the page is newer than our
   * last confirmation: a page served from the offline cache can be older than what we already know.
   */
  async open(matchId: string, seed: PadSeed) {
    await this.init();
    const existing = this.records.get(matchId);
    if (!existing) {
      const record: PadRecord = {
        matchId,
        tournamentId: seed.tournamentId,
        label: seed.label,
        acked: seed.battles,
        ackedAt: seed.renderedAt,
        queue: [],
        submit: null,
        problem: null,
        result: null,
        notice: null,
        syncedAt: null,
        touched: false,
        started: seed.started,
        updatedAt: this.now(),
      };
      this.records.set(matchId, record);
      this.emit();
      await this.storage.put(record);
      return;
    }
    await this.save(matchId, (r) => ({
      label: seed.label,
      // A fresh page also knows whether the match is being played; a Start still waiting here counts.
      ...(seed.renderedAt > r.ackedAt
        ? { acked: seed.battles, ackedAt: seed.renderedAt, started: seed.started || r.queue.some((op) => op.op === "start") }
        : {}),
    }));
  }

  /** "Start match": unlocks scoring at once and tells the server when it can be reached. */
  async start(matchId: string, opId: string) {
    await this.save(matchId, (r) => ({ queue: [...r.queue, { op: "start", opId }], started: true, notice: null }));
    void this.flush();
  }

  battles(matchId: string): PadBattle[] {
    const record = this.records.get(matchId);
    return record ? applyQueue(record.acked, record.queue) : [];
  }

  async enqueue(matchId: string, op: BattleOp) {
    await this.save(matchId, (r) => ({
      queue: [...r.queue, op],
      touched: true,
      // Any edit withdraws a pending or failed submission: the judge must confirm the new result.
      submit: null,
      problem: null,
      result: null,
      notice: null,
    }));
    void this.flush();
  }

  /** Undo: drops the last battle if it never left this device, otherwise asks the server to void it. */
  async undoLast(matchId: string, newOpId: string) {
    const last = this.battles(matchId).at(-1);
    const record = this.records.get(matchId);
    if (!last || !record) return;
    const unsent = record.queue.some((op) => op.op === "add" && op.opId === last.opId) && !this.inFlight.has(last.opId);
    if (unsent) {
      await this.save(matchId, (r) => ({
        queue: r.queue.filter((op) => op.opId !== last.opId),
        touched: true,
        submit: null,
        problem: null,
        result: null,
      }));
      return;
    }
    await this.enqueue(matchId, { op: "void", opId: newOpId, targetOpId: last.opId });
  }

  async requestSubmit(matchId: string, confirmDestructive: boolean) {
    await this.save(matchId, () => ({ submit: { confirmDestructive }, problem: null, result: null }));
    void this.flush();
  }

  async dismissProblem(matchId: string) {
    await this.save(matchId, () => ({ problem: null, submit: null }));
  }

  async acknowledgeResult(matchId: string) {
    await this.save(matchId, () => ({ result: null }));
  }

  /** Throws away unsent work for a match (e.g. it belongs to another account). */
  async discard(matchId: string) {
    this.records.delete(matchId);
    this.emit();
    await this.storage.delete(matchId);
  }

  /** Sends everything that can be sent. Single-flight; a call during a flush schedules one more pass. */
  flush(): Promise<void> {
    if (this.flushing) {
      this.again = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      try {
        do {
          this.again = false;
          await this.init();
          await this.pass();
        } while (this.again);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }

  private setOnline(online: boolean) {
    if (this.online !== online) {
      this.online = online;
      this.emit();
    }
  }

  private async pass() {
    for (const { matchId } of [...this.records.values()].filter(needsWork)) {
      let record = this.records.get(matchId);
      if (!record || record.problem?.kind === "not_found") continue;

      if (record.queue.length) {
        const batch = record.queue;
        batch.forEach((op) => this.inFlight.add(op.opId));
        const res = await this.transport.sendOps(matchId, batch).finally(() => batch.forEach((op) => this.inFlight.delete(op.opId)));
        if (!res.ok) {
          if (await this.failed(matchId, res)) return;
          continue;
        }
        this.setOnline(true);
        const sent = new Set(batch.map((op) => op.opId));
        // A start the server refused (the stadium has no judge) locks scoring again.
        const startRefused = batch.some((op) => op.op === "start" && res.rejected.some((r) => r.opId === op.opId));
        await this.save(matchId, (r) => ({
          acked: res.battles,
          ackedAt: res.serverTime,
          queue: r.queue.filter((op) => !sent.has(op.opId)),
          ...(startRefused ? { started: false } : {}),
          notice: res.rejected[0]?.reason ?? r.notice,
          problem: r.problem?.kind === "signed_out" ? null : r.problem,
        }));
        record = this.records.get(matchId);
      }

      if (record?.submit && record.queue.length === 0) {
        const res = await this.transport.submit(matchId, record.submit.confirmDestructive);
        if (!res.ok) {
          if (await this.failed(matchId, res)) return;
          continue;
        }
        this.setOnline(true);
        const outcome = res.outcome;
        await this.save(matchId, () =>
          outcome.status === "synced"
            ? { submit: null, problem: null, result: { warning: outcome.warning }, touched: false, syncedAt: this.now() }
            : outcome.status === "needs_confirmation"
              ? { submit: null, problem: { kind: "needs_confirmation", affected: outcome.affected } }
              : { submit: null, problem: { kind: "error", message: outcome.error } },
        );
      }
    }
  }

  /** Records a failure. Returns true when the whole pass should stop (the server is unreachable). */
  private async failed(matchId: string, failure: TransportFailure): Promise<boolean> {
    if (failure.reason === "network" || failure.reason === "server") {
      this.setOnline(false);
      return true;
    }
    this.setOnline(true);
    await this.save(matchId, () => ({ problem: { kind: failure.reason as "signed_out" | "not_found" } }));
    // Signed out affects every match; a missing match only this one.
    return failure.reason === "signed_out";
  }
}
