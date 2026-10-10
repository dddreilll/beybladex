import type { ListResponse } from "./types";

export const CHALLONGE_API = "https://api.challonge.com/v2.1";

export type ChallongeErrorDetail = { detail?: string; status?: number; source?: { pointer?: string } };

export class ChallongeError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly details: ChallongeErrorDetail[] = [],
  ) {
    super(`Challonge ${status} on ${path}${details[0]?.detail ? `: ${details[0].detail}` : ""}`);
    this.name = "ChallongeError";
  }
}

/** 401/403 from Challonge: the token is invalid or lacks a scope; the organizer must reconnect. */
export class ChallongeAuthError extends ChallongeError {
  constructor(status: number, path: string, details?: ChallongeErrorDetail[]) {
    super(status, path, details);
    this.name = "ChallongeAuthError";
  }
}

export type RequestEvent = { method: string; path: string; status: number };

type ClientOptions = {
  accessToken: string;
  communityId?: string | null;
  /** Called once per HTTP request (including 304s), so callers can meter the API budget. */
  onRequest?: (event: RequestEvent) => void | Promise<void>;
  fetch?: typeof fetch;
};

export type GetResult<T> = { notModified: true; etag: string | null } | { notModified: false; etag: string | null; body: T };

export class ChallongeClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private url(pathOrUrl: string): string {
    const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : `${CHALLONGE_API}${pathOrUrl}`);
    if (this.options.communityId && !url.searchParams.has("community_id")) {
      url.searchParams.set("community_id", this.options.communityId);
    }
    return url.toString();
  }

  private async request(method: string, pathOrUrl: string, init: { body?: unknown; etag?: string | null } = {}) {
    const url = this.url(pathOrUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/vnd.api+json",
      Accept: "application/json",
      "Authorization-Type": "v2",
      Authorization: `Bearer ${this.options.accessToken}`,
    };
    if (init.etag) headers["If-None-Match"] = init.etag;

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
    const path = new URL(url).pathname.replace(/^\/v2\.1/, "");
    await this.options.onRequest?.({ method, path, status: res.status });

    if (res.status === 304) return { res, json: null };
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    if (!res.ok) {
      const details = Array.isArray((json as { errors?: unknown })?.errors)
        ? ((json as { errors: ChallongeErrorDetail[] }).errors)
        : [];
      if (res.status === 401 || res.status === 403) throw new ChallongeAuthError(res.status, path, details);
      throw new ChallongeError(res.status, path, details);
    }
    return { res, json };
  }

  async get<T>(path: string, options: { etag?: string | null } = {}): Promise<GetResult<T>> {
    const { res, json } = await this.request("GET", path, { etag: options.etag });
    const etag = res.headers.get("etag");
    if (res.status === 304) return { notModified: true, etag: etag ?? options.etag ?? null };
    return { notModified: false, etag, body: json as T };
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return (await this.request("PUT", path, { body })).json as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request("POST", path, { body })).json as T;
  }

  /** Fetches every page by following links.next. Returns the first page's ETag. */
  async listAll<T>(
    path: string,
    options: { perPage?: number; etag?: string | null } = {},
  ): Promise<{ notModified: true; etag: string | null } | { notModified: false; etag: string | null; data: T[] }> {
    const sep = path.includes("?") ? "&" : "?";
    const first = await this.get<ListResponse<T>>(`${path}${sep}page=1&per_page=${options.perPage ?? 500}`, {
      etag: options.etag,
    });
    if (first.notModified) return first;

    const data = [...(first.body.data ?? [])];
    let next = first.body.links?.next ?? null;
    for (let guard = 0; next && guard < 50; guard++) {
      const page = await this.get<ListResponse<T>>(next);
      if (page.notModified) break;
      data.push(...(page.body.data ?? []));
      next = page.body.links?.next ?? null;
    }
    return { notModified: false, etag: first.etag, data };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
