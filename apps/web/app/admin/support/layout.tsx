import "@/app/support/support.css";
export default function SupportAdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="support-shell" data-site-theme="shared">{children}</div>;
}
