import type { Metadata } from "next";
import { Barlow, Chakra_Petch } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { APP_NAME, APP_TAGLINE, appUrl } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl()),
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: `${APP_TAGLINE} ${APP_NAME} runs the bracket, the stadium queues, the judge tablets and the player calls.`,
};

const sans = Barlow({
  variable: "--font-sans",
  weight: ["400", "500", "600", "700"],
  display: "swap",
  subsets: ["latin"],
});

const display = Chakra_Petch({
  variable: "--font-display",
  weight: ["500", "600", "700"],
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${display.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
