import type { ReactNode } from "react";

/** Shared record heading and content frame; an optional sidebar adds the second column. */
export function RecordLayout({ children, sidebar }: { children: ReactNode; sidebar?: ReactNode }) {
  return <>
    <div className="arena-title"><div><span className="arena-eyebrow">STREAMER RECORDS</span><h1>전적 검색</h1><p>한 명의 개인 기록부터 두 스트리머의 맞대결까지.</p></div></div>
    <div className={`arena-workspace record-workspace${sidebar ? "" : " record-workspace-full"}`}>
      <div className="record-main">{children}</div>
      {sidebar}
    </div>
  </>;
}
