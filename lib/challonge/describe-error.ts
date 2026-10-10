import { ChallongeAuthError, ChallongeError } from "./client";
import { NotConnectedError, ReconnectRequiredError } from "./connection";
import { TokenRequestError } from "./oauth";

/** Organizer-facing message for anything thrown while talking to Challonge. */
export function describeChallongeError(error: unknown): string {
  if (error instanceof NotConnectedError || error instanceof ReconnectRequiredError) return error.message;
  if (error instanceof ChallongeAuthError) {
    return "Challonge refused access. Reconnect your Challonge account on the connection page.";
  }
  if (error instanceof ChallongeError) {
    if (error.status === 404) return "Challonge couldn't find that tournament, or it isn't one your account can manage.";
    if (error.status === 429) return "Your Challonge API request limit for this month has been reached.";
    return `Challonge returned an error (${error.status}). Try again in a moment.`;
  }
  if (error instanceof TokenRequestError) return "Challonge rejected the sign-in. Check your client ID and secret.";
  console.error(error);
  return "Something went wrong while talking to Challonge. Try again in a moment.";
}
