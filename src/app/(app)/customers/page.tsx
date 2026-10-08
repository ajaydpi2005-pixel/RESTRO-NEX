import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { getModule } from "@/config/modules";

export const metadata: Metadata = { title: "Customers" };

export default function CustomersPage() {
  return <ModulePlaceholder module={getModule("/customers")} />;
}
