"use client";

import { useState } from "react";
import { MailCheck } from "lucide-react";
import { APP_NAME } from "@/lib/config";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Agreement } from "@/components/legal/agreement";

/**
 * Sign-in is by invite for now: Supabase has sign-ups turned off, so a link is only sent to an
 * email that was invited. `requestAccessUrl` is where someone without an invite can ask for one.
 */
export function LoginForm({
  next,
  requestAccessUrl = null,
  className,
  ...props
}: { next?: string; requestAccessUrl?: string | null } & React.ComponentPropsWithoutRef<"div">) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notInvited, setNotInvited] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const sendLink = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setNotInvited(false);
    const redirect = new URL("/auth/confirm", window.location.origin);
    if (next) redirect.searchParams.set("next", next);

    const { error } = await createClient().auth.signInWithOtp({
      email,
      // Says what we mean. The rule itself is Supabase's sign-up switch, which a browser can't get around.
      options: { emailRedirectTo: redirect.toString(), shouldCreateUser: false },
    });
    setIsLoading(false);
    if (!error) setSentTo(email);
    else if (error.code === "otp_disabled" || error.code === "signup_disabled" || /signups? not allowed/i.test(error.message)) setNotInvited(true);
    else setError(error.message);
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl">Organizer sign in</CardTitle>
          <CardDescription>We&apos;ll email you a one-time sign-in link. No password needed. Access is by invite for now.</CardDescription>
        </CardHeader>
        <CardContent>
          {sentTo ? (
            <div role="status" className="flex flex-col gap-3">
              <div className="flex items-center gap-2 font-semibold text-success">
                <MailCheck className="size-5" aria-hidden />
                Check your inbox
              </div>
              <p className="text-sm text-muted-foreground">
                We sent a sign-in link to <strong className="text-foreground">{sentTo}</strong>. Open it on this
                device to continue.
              </p>
              <Button variant="outline" onClick={() => setSentTo(null)}>
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={sendLink} className="flex flex-col gap-6">
              <div className="grid gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              {notInvited && (
                <p role="alert" className="text-sm text-destructive">
                  This email doesn&apos;t have access yet. {APP_NAME} is invite-only for now.{" "}
                  {requestAccessUrl && (
                    <a href={requestAccessUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
                      Request Early Access
                    </a>
                  )}
                </p>
              )}
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Sending…" : "Email me a sign-in link"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
      <Agreement />
    </div>
  );
}
