import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Shown when the user manages several businesses and hasn't picked one. */
export function MenuBusinessPicker({
  businesses,
  basePath,
}: {
  businesses: { id: string; name: string }[];
  basePath: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Menu</h1>
      <p className="text-muted-foreground">Choose the business whose menu you want to manage.</p>
      <div className="grid gap-4 md:grid-cols-2">
        {businesses.map((business) => (
          <Card key={business.id}>
            <CardHeader>
              <CardTitle className="text-base">{business.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                href={`${basePath}?business=${business.id}`}
                className="text-sm font-medium text-gold-deep underline-offset-4 hover:underline"
              >
                Open menu →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
