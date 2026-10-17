import { SiteHeader, PageShell } from "@/components/public";
import "./support.css";
export const metadata = { title: "건의·문의", robots: { index: false, follow: false } };
export default function SupportLayout({ children }: { children: React.ReactNode }) {
  return <><SiteHeader site="platform" /><PageShell><div className="support-shell">{children}</div></PageShell></>;
}
