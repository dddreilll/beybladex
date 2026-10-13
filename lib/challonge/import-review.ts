import { z } from "zod";
import { IMPORT_REVIEW_TTL_MS } from "@/lib/config";
import { signPayload, verifyPayload } from "@/lib/crypto/secrets";

// A tournament the organizer has reviewed but not imported yet. Reading it cost a Challonge
// request, so what was read goes to the browser and comes back signed, and confirming the import
// doesn't read it again. Signed, a browser can't swap in a format the app refuses.

const reviewedTournament = z.object({
  challongeId: z.string().min(1),
  challongeUrl: z.string(),
  name: z.string(),
  state: z.string(),
  tournamentType: z.string(),
  participantsCount: z.number().int().min(0),
  groupStage: z.boolean(),
});

/** The same shape `mapTournament` returns, which is what an import stores. */
export type ReviewedTournament = z.infer<typeof reviewedTournament>;

// `k` keeps these apart from the other payloads signed with the same key (the OAuth state).
const reviewPayload = z.object({ k: z.literal("import-review"), o: z.string(), exp: z.number(), t: reviewedTournament });

type ReviewOptions = { now?: number; ring?: Parameters<typeof signPayload>[1] };

export class ReviewExpiredError extends Error {
  name = "ReviewExpiredError";
  constructor() {
    super("That review has expired. Review the tournament again.");
  }
}

export function signReview(organizerId: string, tournament: ReviewedTournament, options: ReviewOptions = {}): string {
  const exp = (options.now ?? Date.now()) + IMPORT_REVIEW_TTL_MS;
  return signPayload({ k: "import-review", o: organizerId, exp, t: tournament }, options.ring);
}

/** The tournament in a review token, if it was signed for this organizer and is still fresh. */
export function readReview(organizerId: string, token: string, options: ReviewOptions = {}): ReviewedTournament {
  const payload = reviewPayload.safeParse(verifyPayload(token, options.ring));
  if (!payload.success || payload.data.o !== organizerId || payload.data.exp <= (options.now ?? Date.now())) {
    throw new ReviewExpiredError();
  }
  return payload.data.t;
}
