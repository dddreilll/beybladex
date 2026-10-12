"use client";

import { Printer } from "lucide-react";

export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-black px-5 font-bold text-white"
    >
      <Printer className="size-5" aria-hidden />
      Print
    </button>
  );
}
