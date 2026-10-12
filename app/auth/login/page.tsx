import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { APP_NAME, APP_TAGLINE, earlyAccessUrl, safeNextPath } from "@/lib/config";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <p className="font-display text-xl font-bold">{APP_NAME}</p>
          <p className="text-sm text-muted-foreground">{APP_TAGLINE}</p>
        </div>
        <LoginForm next={safeNextPath(next)} requestAccessUrl={earlyAccessUrl()} />
      </div>
    </main>
  );
}
