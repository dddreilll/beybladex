import { describe, expect, it } from "vitest";
import { callPayload, isAllowedPushEndpoint, subscribeSchema } from "@/lib/push-endpoint";

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
    "https://wns2-sg2p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QGf1abc",
  ])("accepts %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc", // not https
    "https://localhost/internal",
    "https://127.0.0.1:44322/",
    "https://169.254.169.254/latest/meta-data/",
    "https://fcm.googleapis.com.evil.example/fcm/send/abc", // suffix trick
    "https://evilfcm.googleapis.com/fcm/send/abc",
    "https://evil.example/?x=.push.apple.com",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "not a url",
    "",
  ])("rejects %s", (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

describe("subscribeSchema", () => {
  const valid = {
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "BObk_-abc", auth: "q1w2e3" } },
  };

  it("accepts a browser subscription", () => {
    expect(subscribeSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects other hosts and malformed keys", () => {
    expect(subscribeSchema.safeParse({ ...valid, subscription: { ...valid.subscription, endpoint: "https://evil.example/x" } }).success).toBe(false);
    expect(subscribeSchema.safeParse({ ...valid, subscription: { ...valid.subscription, keys: { p256dh: "<script>", auth: "x" } } }).success).toBe(false);
  });
});

describe("callPayload", () => {
  const base = { stadium: "Stadium 2", opponent: "Sam", label: "Winners R2 · Match 9", slug: "abcdef0123456789", matchId: "m1" };

  it("tells a called player where to go", () => {
    expect(callPayload({ ...base, status: "called" })).toEqual({
      title: "You're up at Stadium 2",
      body: "vs Sam · Winners R2 · Match 9. Head there now.",
      tag: "match-m1",
      url: "/t/abcdef0123456789",
    });
  });

  it("uses the same tag on deck, so the call replaces it", () => {
    const onDeck = callPayload({ ...base, status: "on_deck" });
    expect(onDeck.title).toBe("On deck at Stadium 2");
    expect(onDeck.tag).toBe("match-m1");
  });
});
