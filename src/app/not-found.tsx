import Link from "next/link";
import { LogoMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 px-4 text-center">
      <LogoMark className="size-12" />
      <div className="space-y-2">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-sm text-muted-foreground">
          This route is not part of RestroNex yet. The current build covers the foundation and
          roadmap placeholders only.
        </p>
      </div>
      <Button asChild>
        <Link href="/">Back to home</Link>
      </Button>
    </div>
  );
}
