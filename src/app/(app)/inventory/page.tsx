import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Inventory" };

export default function InventoryPage() {
  return <ModulePlaceholder module={getModule("/inventory")} />;
}
