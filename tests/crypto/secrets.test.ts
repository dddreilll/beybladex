import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, parseKeyring, signPayload, verifyPayload } from "@/lib/crypto/secrets";

const key = () => randomBytes(32).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  const ring = parseKeyring(`v1:${key()}`);

  it("round-trips a secret", () => {
    const envelope = encryptSecret("client-secret-123", "org-1:client_secret", ring);
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("client-secret-123");
    expect(decryptSecret(envelope, "org-1:client_secret", ring)).toBe("client-secret-123");
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same", "aad", ring)).not.toBe(encryptSecret("same", "aad", ring));
  });

  it("rejects a ciphertext moved to another owner or field", () => {
    const envelope = encryptSecret("token", "org-1:access_token", ring);
    expect(() => decryptSecret(envelope, "org-2:access_token", ring)).toThrow();
    expect(() => decryptSecret(envelope, "org-1:refresh_token", ring)).toThrow();
  });

  it("rejects tampering", () => {
    const [v, iv, tag, ct] = encryptSecret("token", "aad", ring).split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), "aad", ring)).toThrow();
  });

  it("decrypts values written with an older key after rotation", () => {
    const oldKey = key();
    const before = parseKeyring(`v1:${oldKey}`);
    const envelope = encryptSecret("legacy", "aad", before);
    const after = parseKeyring(`v2:${key()},v1:${oldKey}`);
    expect(decryptSecret(envelope, "aad", after)).toBe("legacy");
    expect(encryptSecret("new", "aad", after).startsWith("v2.")).toBe(true);
  });

  it("validates the keyring format", () => {
    expect(() => parseKeyring(undefined)).toThrow(/not set/);
    expect(() => parseKeyring("v1:short")).toThrow(/32 bytes/);
    expect(() => parseKeyring(`nope:${key()}`)).toThrow(/v1:<base64>/);
  });
});

describe("signPayload / verifyPayload", () => {
  const ring = parseKeyring(`v1:${key()}`);

  it("verifies its own payloads", () => {
    const token = signPayload({ o: "org-1", n: "nonce", exp: 123 }, ring);
    expect(verifyPayload(token, ring)).toEqual({ o: "org-1", n: "nonce", exp: 123 });
  });

  it("rejects modified payloads and other keys", () => {
    const token = signPayload({ o: "org-1" }, ring);
    const [, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ o: "org-2" })).toString("base64url")}.${mac}`;
    expect(verifyPayload(forged, ring)).toBeNull();
    expect(verifyPayload(token, parseKeyring(`v1:${key()}`))).toBeNull();
    expect(verifyPayload("garbage", ring)).toBeNull();
  });
});
