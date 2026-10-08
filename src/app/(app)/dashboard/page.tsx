import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <ModulePlaceholder module={getModule("/dashboard")} />;
}
