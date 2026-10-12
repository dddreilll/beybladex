import { describe, expect, it } from "vitest";
import {
  deviceLabel,
  hashToken,
  judgeName,
  newPairingCode,
  newPasscode,
  newSessionToken,
  newSignInToken,
  PASSCODE_PATTERN,
  sameSecret,
  SIGN_IN_TOKEN_PATTERN,
} from "@/lib/access-codes";

describe("codes and tokens", () => {
  it("makes 4-digit passcodes, keeping leading zeros", () => {
    const codes = Array.from({ length: 500 }, newPasscode);
    expect(codes.every((c) => PASSCODE_PATTERN.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(400);
  });

  it("makes pairing codes without look-alike characters", () => {
    const codes = Array.from({ length: 500 }, newPairingCode);
    expect(codes.every((c) => /^[A-HJKMNP-Z2-9]{4}$/.test(c))).toBe(true);
    expect(codes.join("")).not.toMatch(/[01OIL]/);
  });

  it("makes QR secrets in the same shape as the database default", () => {
    expect(newSignInToken()).toMatch(SIGN_IN_TOKEN_PATTERN);
    expect(newSignInToken()).not.toBe(newSignInToken());
  });

  it("stores only a hash of a session cookie", () => {
    const token = newSessionToken();
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(newSessionToken()));
  });

  it("compares secrets exactly, whatever their lengths", () => {
    expect(sameSecret("4821", "4821")).toBe(true);
    expect(sameSecret("4821", "4822")).toBe(false);
    expect(sameSecret("4821", "48210")).toBe(false);
    expect(sameSecret("", "4821")).toBe(false);
  });
});

describe("deviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome on Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0", "Edge on Windows"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", "Safari on iPhone"],
    ["Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome on Android"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0", "Firefox on Mac"],
    ["Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/7.4 Chrome/120.0.0.0 TV Safari/537.36", "Samsung Internet on a smart TV"],
  ])("names %s", (userAgent, label) => {
    expect(deviceLabel(userAgent)).toBe(label);
  });

  it("never returns an empty name", () => {
    expect(deviceLabel(null)).toBe("Unknown device");
    expect(deviceLabel("curl/8.0")).toBe("Unknown device");
    expect(deviceLabel("SomethingNew (Linux)")).toBe("Linux");
  });
});

describe("judgeName", () => {
  it("keeps what the judge typed, tidied", () => {
    expect(judgeName("Maria", "Chrome on Android")).toBe("Maria");
    expect(judgeName("  Maria   K.  ", "Chrome on Android")).toBe("Maria K.");
  });

  it("falls back to the detected device when left blank", () => {
    expect(judgeName("", "Chrome on Android")).toBe("Chrome on Android");
    expect(judgeName("   ", "Chrome on Android")).toBe("Chrome on Android");
    expect(judgeName(null, "Chrome on Android")).toBe("Chrome on Android");
    expect(judgeName(undefined, "Chrome on Android")).toBe("Chrome on Android");
  });

  it("cuts a long name to 30 characters without a trailing space", () => {
    const name = judgeName("Head judge of the main stadium table", "x");
    expect(name).toBe("Head judge of the main stadium");
    expect(name.length).toBeLessThanOrEqual(30);
  });
});
