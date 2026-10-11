import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Shown when the viewer manages several businesses and has not picked one. */
export function InventoryBusinessPicker({
  businesses,
  basePath,
}: {
  businesses: { id: string; name: string }[];
  basePath: string;
}) {
  return (
    <div className="space-y-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Inventory</h1>
      <p className="text-muted-foreground">Choose the business whose stock you want to manage.</p>
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
                Open inventory →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function InventoryDenied() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Inventory</h1>
      <p className="text-muted-foreground">You don&apos;t have permission to view inventory in this business.</p>
    </div>
  );
}

export function InventoryNoOutlet() {
  return (
    <div className="space-y-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Inventory</h1>
      <p className="text-muted-foreground">
        No outlet is assigned to you. Ask an owner or admin to add an outlet and assign you to it.
      </p>
    </div>
  );
}
