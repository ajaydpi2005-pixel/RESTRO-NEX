"use client";

/**
 * Reads the current year on the client. Wrapped in a Suspense boundary
 * by the consumer so Next.js Cache Components can keep pages fully
 * static (the current time is unstable during prerender).
 */
export function CurrentYear() {
  return <>{new Date().getFullYear()}</>;
}
