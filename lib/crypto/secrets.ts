import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope format for encrypted secrets: `<keyVersion>.<iv>.<authTag>.<ciphertext>` (base64url).
 * Keys come from APP_ENCRYPTION_KEYS as `v2:<base64 32 bytes>,v1:<base64 32 bytes>`;
 * the first key encrypts, every listed key can decrypt (so old rows survive a rotation).
 */

type Keyring = { active: string; keys: Map<string, Buffer> };

export function parseKeyring(raw: string | undefined): Keyring {
  if (!raw) throw new Error("APP_ENCRYPTION_KEYS is not set.");
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [version, material] = entry.split(":");
    if (!version || !material || !/^v\d+$/.test(version)) {
      throw new Error(`APP_ENCRYPTION_KEYS entry "${version ?? entry}" must look like v1:<base64>.`);
    }
    const key = Buffer.from(material, "base64");
    if (key.length !== 32) throw new Error(`Encryption key ${version} must be 32 bytes.`);
    keys.set(version, key);
  }
  const active = raw.split(",")[0].split(":")[0].trim();
  return { active, keys };
}

let cached: Keyring | undefined;
function keyring(): Keyring {
  cached ??= parseKeyring(process.env.APP_ENCRYPTION_KEYS);
  return cached;
}

/** `aad` binds the ciphertext to its owner (e.g. the organizer id) so it can't be moved to another row. */
export function encryptSecret(plaintext: string, aad: string, ring: Keyring = keyring()): string {
  const key = ring.keys.get(ring.active)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [ring.active, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

export function decryptSecret(envelope: string, aad: string, ring: Keyring = keyring()): string {
  const [version, iv, tag, ciphertext] = envelope.split(".");
  const key = ring.keys.get(version);
  if (!key || !iv || !tag || ciphertext === undefined) {
    throw new Error("Encrypted value is malformed or uses an unknown key version.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function signingKey(ring: Keyring): Buffer {
  return Buffer.from(hkdfSync("sha256", ring.keys.get(ring.active)!, "", "signed-payload/v1", 32));
}

/** Short-lived signed payloads (e.g. the OAuth `state`). Not encrypted: don't put secrets in them. */
export function signPayload(payload: Record<string, unknown>, ring: Keyring = keyring()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", signingKey(ring)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyPayload<T extends Record<string, unknown>>(
  token: string,
  ring: Keyring = keyring(),
): T | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", signingKey(ring)).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
