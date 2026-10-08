import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Menu Management" };

export default function MenuPage() {
  return <ModulePlaceholder module={getModule("/menu")} />;
}
