import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";
import { APP_NAME, safeNextPath } from "@/lib/config";

export const metadata: Metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-center font-display text-xl font-bold">{APP_NAME}</p>
        <LoginForm next={safeNextPath(next)} />
      </div>
    </main>
  );
}
