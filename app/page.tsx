import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentOrganizer } from "@/lib/auth";
import { APP_NAME } from "@/lib/config";
import { hasEnvVars } from "@/lib/utils";

export default async function Home() {
  if (hasEnvVars && (await currentOrganizer())) redirect("/tournaments");

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-4">
        <p className="font-display text-lg font-semibold text-muted-foreground">{APP_NAME}</p>
        <h1 className="font-display text-4xl font-bold leading-tight sm:text-5xl">
          Run your Beyblade X tournament from one screen.
        </h1>
        <p className="text-lg text-muted-foreground">
          Call players to stadiums, score battles finish by finish, and keep your Challonge bracket in sync.
        </p>
      </div>
      <div>
        {hasEnvVars ? (
          <Button asChild size="lg">
            <Link href="/auth/login">Organizer sign in</Link>
          </Button>
        ) : (
          <p role="alert" className="text-sm text-warning">
            Supabase environment variables are missing. See the README to set up .env.local.
          </p>
        )}
      </div>
    </main>
  );
}
