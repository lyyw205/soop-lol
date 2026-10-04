import { notFound, redirect } from "next/navigation";

import { matchModuleRoute } from "@soop-lol/modules/registry";
import { moduleUi } from "@soop-lol/modules/ui";

import { roleHref } from "@/lib/module-links";

/**
 * FC 사이트 안의 모듈 화면 마운트 지점. app/[...path] 와 같은 일을 하되 **FC 레이아웃 안**이라
 * FC 머리말·본문 폭을 그대로 쓴다(그건 app/fc/layout.tsx 가 씌운다).
 * 모듈이 module.json 에 적은 /fc/... 경로가 곧 주소다 — core 는 모듈 이름을 모른다.
 */
type Props = {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function resolve(props: Props) {
  const hit = matchModuleRoute(["fc", ...(await props.params).path]);
  const load = hit?.module.site === "fconline" ? moduleUi(hit.module.name) : undefined;
  if (!hit || !load) return null;
  return { params: hit.params, searchParams: await props.searchParams, ui: await load() };
}

export async function generateMetadata(props: Props) {
  const r = await resolve(props);
  if (!r) return {};
  return r.ui.generateMetadata?.({ params: r.params, searchParams: r.searchParams, roleHref }) ?? {};
}

/**
 * 없앤 화면의 옛 주소 → 그 내용을 이어받은 **역할**. 모듈 이름·주소를 박지 않고 역할로 묻는다 —
 * 이어받은 모듈도 없으면 그냥 404 다.
 *   leaderboard: 2026-10-02 삭제(수집량 순 승수 줄 세우기). 실력 지표는 구단가치 화면의 공식경기 등급이 맡는다.
 */
const RETIRED: Record<string, string> = { leaderboard: "fc-club-value" };

export default async function FcModuleRoutePage(props: Props) {
  const r = await resolve(props);
  if (!r) {
    const path = (await props.params).path;
    const successor = path.length === 1 && RETIRED[path[0]] ? roleHref(RETIRED[path[0]]) : null;
    if (successor) redirect(successor);
    notFound();
  }
  const View = r.ui.default;
  return <View params={r.params} searchParams={r.searchParams} roleHref={roleHref} />;
}
