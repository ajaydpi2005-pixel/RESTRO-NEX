import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Kitchen Display" };

export default function KitchenPage() {
  return <ModulePlaceholder module={getModule("/kitchen")} />;
}
