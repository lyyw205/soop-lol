import { notFound } from "next/navigation";

import { matchModuleRoute } from "@soop-lol/modules/registry";
import { moduleUi } from "@soop-lol/modules/ui";

import { roleHref } from "@/lib/module-links";

/**
 * 롤 공간 안의 모듈 화면 마운트 지점. app/fc/[...path] 와 같은 일을 하되 롤 레이아웃(머리말) 안이다.
 * 모듈이 module.json 에 적은 /lol/... 경로가 곧 주소다 — core 는 모듈 이름을 모른다.
 */
type Props = {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function resolve(props: Props) {
  const hit = matchModuleRoute(["lol", ...(await props.params).path]);
  const load = hit?.module.site === "lol" ? moduleUi(hit.module.name) : undefined;
  if (!hit || !load) return null;
  return { params: hit.params, searchParams: await props.searchParams, ui: await load() };
}

export async function generateMetadata(props: Props) {
  const r = await resolve(props);
  if (!r) return {};
  return r.ui.generateMetadata?.({ params: r.params, searchParams: r.searchParams, roleHref }) ?? {};
}

export default async function LolModuleRoutePage(props: Props) {
  const r = await resolve(props);
  if (!r) notFound();
  const View = r.ui.default;
  return <main className="arena-shell"><View params={r.params} searchParams={r.searchParams} roleHref={roleHref} /></main>;
}
