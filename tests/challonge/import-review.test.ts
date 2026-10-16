import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readReview, ReviewExpiredError, signReview, type ReviewedTournament } from "@/lib/challonge/import-review";
import { IMPORT_REVIEW_TTL_MS } from "@/lib/config";
import { parseKeyring, signPayload } from "@/lib/crypto/secrets";

const ring = parseKeyring(`v1:${randomBytes(32).toString("base64")}`);
const now = 1_700_000_000_000;

const tournament: ReviewedTournament = {
  challongeId: "18602864",
  challongeUrl: "xl4tobg6",
  name: "[SPIKE]",
  state: "underway",
  tournamentType: "double elimination",
  participantsCount: 16,
  groupStage: false,
  groupStageType: null,
  groupSize: null,
  startedAt: null,
  swissRounds: null,
};

describe("import review tokens", () => {
  const token = signReview("org-1", tournament, { now, ring });

  it("returns the reviewed tournament to the organizer it was signed for", () => {
    expect(readReview("org-1", token, { now: now + 1000, ring })).toEqual(tournament);
  });

  it("carries when a tournament started, which a two-stage one needs to tell its stages apart", () => {
    const started = { ...tournament, groupStage: true, groupStageType: "swiss", groupSize: 4, startedAt: new Date("2026-10-13T23:32:41.056Z") };
    expect(readReview("org-1", signReview("org-1", started, { now, ring }), { now, ring })).toEqual(started);
  });

  it("refuses another organizer", () => {
    expect(() => readReview("org-2", token, { now, ring })).toThrow(ReviewExpiredError);
  });

  it("expires", () => {
    expect(readReview("org-1", token, { now: now + IMPORT_REVIEW_TTL_MS - 1, ring })).toEqual(tournament);
    expect(() => readReview("org-1", token, { now: now + IMPORT_REVIEW_TTL_MS, ring })).toThrow("That review has expired. Review the tournament again.");
  });

  it("refuses a tournament the browser changed", () => {
    const [, mac] = token.split(".");
    const swapped = { k: "import-review", o: "org-1", exp: now + IMPORT_REVIEW_TTL_MS, t: { ...tournament, tournamentType: "free for all" } };
    const forged = `${Buffer.from(JSON.stringify(swapped)).toString("base64url")}.${mac}`;
    expect(() => readReview("org-1", forged, { now, ring })).toThrow(ReviewExpiredError);
    expect(() => readReview("org-1", "", { now, ring })).toThrow(ReviewExpiredError);
  });

  it("refuses other payloads signed with the same key, such as an OAuth state", () => {
    const oauthState = signPayload({ o: "org-1", n: "nonce", exp: now + IMPORT_REVIEW_TTL_MS }, ring);
    expect(() => readReview("org-1", oauthState, { now, ring })).toThrow(ReviewExpiredError);
    const incomplete = signPayload({ k: "import-review", o: "org-1", exp: now + IMPORT_REVIEW_TTL_MS, t: { challongeId: "1" } }, ring);
    expect(() => readReview("org-1", incomplete, { now, ring })).toThrow(ReviewExpiredError);
  });
});
