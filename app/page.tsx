import { Landing } from "@/components/landing/landing";
import { currentOrganizer } from "@/lib/auth";
import { earlyAccessUrl } from "@/lib/config";
import { hasEnvVars } from "@/lib/utils";

export default async function Home() {
  // Signed-in organizers see the page too; its buttons then lead to their tournaments.
  const organizer = hasEnvVars ? await currentOrganizer() : null;

  return <Landing canSignIn={Boolean(hasEnvVars)} signedIn={Boolean(organizer)} earlyAccessUrl={earlyAccessUrl()} />;
}
