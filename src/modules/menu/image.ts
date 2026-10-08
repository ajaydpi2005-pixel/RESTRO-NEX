import { getSupabaseEnv } from "@/lib/env";

/** Public URL for an object in the menu-media bucket (null-safe). */
export function menuImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  try {
    const { url } = getSupabaseEnv();
    return `${url}/storage/v1/object/public/menu-media/${path}`;
  } catch {
    return null;
  }
}
