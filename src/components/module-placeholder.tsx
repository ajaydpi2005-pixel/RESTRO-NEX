import { CheckCircle2, Map } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface PlaceholderModule {
  title: string;
  description: string;
  phase: number;
  phaseName: string;
  planned: readonly string[];
}

/**
 * Honest roadmap placeholder for a module that has not been built yet.
 * Renders strictly from the roadmap registry — no fake data, no dead
 * controls. Replaced page-by-page as each phase ships.
 */
export function ModulePlaceholder({
  module: subject,
  tone = "app",
}: {
  module: PlaceholderModule;
  tone?: "app" | "admin";
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Badge variant="outline" className="w-fit border-gold/50 text-muted-foreground">
          Phase {subject.phase} · {subject.phaseName}
        </Badge>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{subject.title}</h1>
        <p className="max-w-2xl text-muted-foreground">{subject.description}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Planned capabilities</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {subject.planned.map((capability) => (
                <li
                  key={capability}
                  className="flex items-start gap-2.5 text-sm text-muted-foreground"
                >
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-gold-deep dark:text-gold" />
                  {capability}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p className="flex items-start gap-2.5">
              <Map className="mt-0.5 size-4 shrink-0 text-gold-deep dark:text-gold" />
              This module is on the committed build roadmap. The route, navigation and design
              system are ready; the feature itself ships in its phase.
            </p>
            <p>
              {tone === "admin"
                ? "No sample data is shown. The Super Admin console is protected separately and is never granted through public sign-up."
                : "No sample data is shown. Nothing on this page is hardcoded business data."}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
