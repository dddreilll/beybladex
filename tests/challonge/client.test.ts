import { describe, expect, it, vi } from "vitest";
import { ChallongeAuthError, ChallongeClient, ChallongeError } from "@/lib/challonge/client";

function fakeFetch(responses: Array<{ status: number; body?: unknown; etag?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request");
    const headers = new Headers(next.etag ? { etag: next.etag } : {});
    return new Response(next.status === 304 ? null : JSON.stringify(next.body ?? {}), { status: next.status, headers });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("ChallongeClient", () => {
  it("sends the v2.1 OAuth headers", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { data: { id: "1" } } }]);
    await new ChallongeClient({ accessToken: "tok", fetch: impl }).get("/me.json");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe("https://api.challonge.com/v2.1/me.json");
    expect(headers).toMatchObject({
      Authorization: "Bearer tok",
      "Authorization-Type": "v2",
      "Content-Type": "application/vnd.api+json",
      Accept: "application/json",
    });
  });

  it("adds community_id when configured", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: {} }]);
    await new ChallongeClient({ accessToken: "t", communityId: "beyclub", fetch: impl }).get("/tournaments/1.json");
    expect(new URL(calls[0].url).searchParams.get("community_id")).toBe("beyclub");
  });

  it("follows links.next and returns the first page's ETag", async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        etag: 'W/"first"',
        body: { data: [{ id: "1" }, { id: "2" }], links: { next: "https://api.challonge.com/v2.1/tournaments/9/matches.json?page=2&per_page=2" } },
      },
      { status: 200, body: { data: [{ id: "3" }], links: { next: null } } },
    ]);
    const result = await new ChallongeClient({ accessToken: "t", fetch: impl }).listAll<{ id: string }>(
      "/tournaments/9/matches.json",
      { perPage: 2 },
    );
    expect(result).toEqual({ notModified: false, etag: 'W/"first"', data: [{ id: "1" }, { id: "2" }, { id: "3" }] });
    expect(calls[0].url).toContain("page=1&per_page=2");
    expect(calls).toHaveLength(2);
  });

  it("sends If-None-Match and reports 304 as not modified", async () => {
    const { impl, calls } = fakeFetch([{ status: 304 }]);
    const result = await new ChallongeClient({ accessToken: "t", fetch: impl }).listAll("/tournaments/9/matches.json", {
      etag: 'W/"abc"',
    });
    expect((calls[0].init.headers as Record<string, string>)["If-None-Match"]).toBe('W/"abc"');
    expect(result).toEqual({ notModified: true, etag: 'W/"abc"' });
  });

  it("meters every request, including 304s and errors", async () => {
    const onRequest = vi.fn();
    const { impl } = fakeFetch([{ status: 304 }, { status: 404, body: { errors: [{ detail: "Not found" }] } }]);
    const client = new ChallongeClient({ accessToken: "t", fetch: impl, onRequest });
    await client.get("/a.json", { etag: "x" });
    await expect(client.get("/b.json")).rejects.toBeInstanceOf(ChallongeError);
    expect(onRequest.mock.calls.map(([e]) => [e.path, e.status])).toEqual([
      ["/a.json", 304],
      ["/b.json", 404],
    ]);
  });

  it("raises an auth error for 401 and keeps Challonge's error detail", async () => {
    const { impl } = fakeFetch([{ status: 401, body: { errors: [{ detail: "Invalid token", status: 401 }] } }]);
    const error = await new ChallongeClient({ accessToken: "t", fetch: impl }).get("/me.json").catch((e) => e);
    expect(error).toBeInstanceOf(ChallongeAuthError);
    expect(error.message).toContain("Invalid token");
  });
});
