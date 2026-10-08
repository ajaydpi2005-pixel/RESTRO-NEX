import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "POS" };

export default function PosPage() {
  return <ModulePlaceholder module={getModule("/pos")} />;
}
