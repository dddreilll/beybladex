import { describe, expect, it, vi } from "vitest";
import { authorizeUrl, refreshAccessToken, tokenExpiry, TokenRequestError } from "@/lib/challonge/oauth";

describe("authorizeUrl", () => {
  it("requests the scopes the app needs with the organizer's own client id", () => {
    const url = new URL(authorizeUrl({ clientId: "abc", redirectUri: "http://localhost:3000/cb", state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://api.challonge.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "abc",
      redirect_uri: "http://localhost:3000/cb",
      response_type: "code",
      scope: "me tournaments:read tournaments:write matches:read matches:write participants:read participants:write",
      state: "s1",
    });
  });
});

describe("refreshAccessToken", () => {
  it("posts a form-encoded refresh grant and counts the request", async () => {
    let body: URLSearchParams | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = init?.body as URLSearchParams;
      return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 604800, created_at: 1_000 });
    }) as unknown as typeof fetch;
    const onRequest = vi.fn();

    const token = await refreshAccessToken(
      { clientId: "id", clientSecret: "secret", refreshToken: "old" },
      { fetch: fetchImpl, onRequest },
    );
    expect(Object.fromEntries(body!)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old",
      client_id: "id",
      client_secret: "secret",
    });
    expect(token.refresh_token).toBe("rotated");
    expect(onRequest).toHaveBeenCalledOnce();
  });

  it("flags invalid_grant as needing re-authorization", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })) as unknown as typeof fetch;
    const error = await refreshAccessToken({ clientId: "i", clientSecret: "s", refreshToken: "r" }, { fetch: fetchImpl }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(TokenRequestError);
    expect(error.needsReauthorization).toBe(true);
  });
});

describe("tokenExpiry", () => {
  it("uses created_at + expires_in when present", () => {
    expect(tokenExpiry({ access_token: "a", created_at: 1_000, expires_in: 604800 }).getTime()).toBe((1_000 + 604800) * 1000);
  });
});
