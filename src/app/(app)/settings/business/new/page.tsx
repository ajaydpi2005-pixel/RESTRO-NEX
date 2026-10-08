import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BusinessForm } from "@/modules/business/components/business-form";

export const metadata: Metadata = { title: "New business" };

export default function NewBusinessPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <Link
          href="/settings/business"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" /> Businesses
        </Link>
        <h1 className="font-display text-3xl font-semibold tracking-tight">New business</h1>
        <p className="text-muted-foreground">
          The business owns your brand, tax profile and every outlet you add next.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Business details</CardTitle>
          <CardDescription>All fields except name, type, currency and timezone are optional.</CardDescription>
        </CardHeader>
        <CardContent>
          <BusinessForm mode="create" />
        </CardContent>
      </Card>
    </div>
  );
}
