"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * RestroNex theme provider.
 *
 * Class-based dark mode so every surface can be themed through the
 * design tokens in globals.css. Defaults to the system preference.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
