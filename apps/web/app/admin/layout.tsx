import "@/components/admin/admin.css";

import { AdminShell } from "@/components/admin/AdminShell";

export const metadata = { title: "운영 콘솔", robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-theme min-h-dvh bg-ink-950 text-ink-200">
      <AdminShell>{children}</AdminShell>
    </div>
  );
}
