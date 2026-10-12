import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// Codes, cookies and device names for the two restricted public screens: the call board
// (approved by the organizer) and the player page (a passcode per player).

/** What a player types: 4 digits, easy on a phone keypad. Guessing is slowed down on the server. */
export const PASSCODE_PATTERN = /^\d{4}$/;
export const newPasscode = () => String(randomInt(10_000)).padStart(4, "0");

/** The secret inside a player's personal QR code (32 hex characters, like the database default). */
export const SIGN_IN_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
export const newSignInToken = () => randomBytes(16).toString("hex");

// No look-alikes (0/O, 1/I/L): the organizer compares this code on a TV with the control room.
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newPairingCode = () =>
  Array.from({ length: 4 }, () => PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)]).join("");

/** A session cookie's value. Only its hash is stored, so a database leak can't be replayed. */
export const newSessionToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A tournament's short link code (/b/<code>, /j/<code>), as app.short_code() makes them. */
export const SHORT_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/;

export const boardCookie = (slug: string) => `board_${slug}`;
export const judgeCookie = (slug: string) => `judge_${slug}`;
export const playerCookie = (slug: string) => `player_${slug}`;

/** Compares two secrets without revealing, through timing, how many characters matched. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const JUDGE_NAME_MAX = 30;

/** A judge's chosen name, tidied; a blank one falls back to the detected device name. */
export function judgeName(raw: string | null | undefined, fallback: string): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, JUDGE_NAME_MAX).trim() || fallback;
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const PLATFORMS: [RegExp, string][] = [
  [/SmartTV|SMART-TV|Tizen|Web0S|webOS|AppleTV|Android TV|BRAVIA|AFT[A-Z]/, "a smart TV"],
  [/iPhone|iPod/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "a Chromebook"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux/, "Linux"],
];

/** "Chrome on Windows": enough for the organizer to tell screens apart. */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const platform = PLATFORMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? (platform ? platform.replace(/^a /, "A ") : "Unknown device");
}
