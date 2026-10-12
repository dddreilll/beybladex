import { cn } from "@/lib/utils";

/**
 * The line under a sign-in button. The links open in a new tab, so following one doesn't lose
 * what was typed (or leave an installed Pass).
 */
export function Agreement({ className }: { className?: string }) {
  const link = "underline underline-offset-4 hover:text-foreground";
  return (
    <p className={cn("text-balance text-center text-xs text-muted-foreground", className)}>
      By continuing, you agree to our{" "}
      <a href="/terms" target="_blank" rel="noopener" className={link}>
        Terms of Service
      </a>{" "}
      and{" "}
      <a href="/privacy" target="_blank" rel="noopener" className={link}>
        Privacy Policy
      </a>
      .
    </p>
  );
}
