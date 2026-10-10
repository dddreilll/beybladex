import type { PadTransport, TransportFailure } from "./outbox";

// Plain endpoints rather than server actions: a pad page restored from the offline cache may
// come from an older deploy, and server action ids change on every build.

async function post<T>(url: string, body: unknown): Promise<{ ok: true; data: T } | TransportFailure> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: "network" };
  }
  if (res.status === 401) return { ok: false, reason: "signed_out" };
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (!res.ok) return { ok: false, reason: "server" };
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    // An HTML page instead of JSON: a captive portal or a login redirect.
    return { ok: false, reason: "network" };
  }
}

export const httpTransport: PadTransport = {
  async sendOps(matchId, ops) {
    const res = await post<{ battles: never[]; serverTime: number; rejected: { opId: string; reason: string }[] }>(
      `/api/matches/${matchId}/battles`,
      { ops },
    );
    return res.ok ? { ok: true, ...res.data } : res;
  },
  async submit(matchId, confirmDestructive) {
    const res = await post<never>(`/api/matches/${matchId}/result`, { confirmDestructive });
    return res.ok ? { ok: true, outcome: res.data } : res;
  },
};
