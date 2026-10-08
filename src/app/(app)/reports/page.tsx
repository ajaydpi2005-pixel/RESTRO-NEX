import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return <ModulePlaceholder module={getModule("/reports")} />;
}
