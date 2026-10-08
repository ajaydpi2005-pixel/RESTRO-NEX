import type { Metadata } from "next";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { adminModule } from "@/config/modules";

export const metadata: Metadata = { title: "Super Admin" };

export default function AdminPage() {
  return <ModulePlaceholder module={adminModule} tone="admin" />;
}
