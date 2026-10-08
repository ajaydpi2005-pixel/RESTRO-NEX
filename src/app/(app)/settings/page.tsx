import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <ModulePlaceholder module={getModule("/settings")} />;
}
