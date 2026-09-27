import type { FcoPerson } from "@soop-lol/core/lib/contract";
import { RecordSearch } from "../record-search.tsx";

/**
 * FC 전적 검색. 상대전적 탭은 그 화면을 가진 모듈이 있을 때만 뜬다 —
 * 경로는 부르는 쪽이 등록부에 물어 넘긴다(공용 UI 는 등록부를 모른다).
 */
export function FcRecordSearch({ people, a, b, mode = "personal", versusPath }: {
  people: FcoPerson[];
  a?: string;
  b?: string;
  mode?: "personal" | "versus";
  versusPath: string | null;
}) {
  return <RecordSearch
    key={`${mode}:${a ?? ""}:${b ?? ""}`}
    options={people.map((person) => ({
      slug: person.slug,
      display_name: person.name,
      aliases: [person.nickname],
      channel_id: person.channel_id,
      subtitle: `감독명 ${person.nickname}`,
    }))}
    a={a}
    b={b}
    mode={mode}
    personalPathPrefix="/fc/s"
    includeOpponentInPersonal={false}
    versusPath={versusPath}
    personalHint="스트리머 한 명의 FC 온라인 경기 기록과 스쿼드를 살펴보세요."
    versusHint="두 스트리머가 실제로 맞붙은 FC 온라인 경기와 상대전적을 비교하세요."
  />;
}
