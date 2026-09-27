import { notFound } from "next/navigation";

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
  const load = hit?.module.game === "fconline" ? moduleUi(hit.module.name) : undefined;
  if (!hit || !load) return null;
  return { params: hit.params, searchParams: await props.searchParams, ui: await load() };
}

export async function generateMetadata(props: Props) {
  const r = await resolve(props);
  if (!r) return {};
  return r.ui.generateMetadata?.({ params: r.params, searchParams: r.searchParams, roleHref }) ?? {};
}

export default async function FcModuleRoutePage(props: Props) {
  const r = await resolve(props);
  if (!r) notFound();
  const View = r.ui.default;
  return <View params={r.params} searchParams={r.searchParams} roleHref={roleHref} />;
}
