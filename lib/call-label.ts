import { ordinal } from "@/lib/format";

const WORDS = ["", "", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

/**
 * "Second call", "Third call", … for a recalled match; null for the first call.
 * A missing or invalid count is treated as a first call: this text is shown to players, so it
 * must never render a broken label.
 */
export function callLabel(callNumber: number | null | undefined): string | null {
  if (typeof callNumber !== "number" || !Number.isInteger(callNumber) || callNumber <= 1) return null;
  return `${WORDS[callNumber] ?? ordinal(callNumber)} call`;
}
