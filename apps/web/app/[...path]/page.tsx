import { notFound } from "next/navigation";

import { matchModuleRoute } from "@soop-lol/modules/registry";
import { moduleUi } from "@soop-lol/modules/ui";

import { SiteHeader } from "@/components/public";
import { roleHref } from "@/lib/module-links";

/**
 * 모듈 화면 마운트 지점. core 화면이 차지하지 않은 주소는 전부 여기로 온다.
 *
 * core 웹은 어떤 모듈이 있는지 **모른다**. 등록부에 "이 주소를 선언한 모듈이 있나" 만 묻는다.
 * 모듈이 module.json 에 적은 경로가 곧 주소다(/tournaments/[slug], /m/versus …).
 * 모듈 디렉터리를 지우고 `npm run modules:sync` 를 돌리면 그 주소는 404 가 된다 — core 는 무변경.
 *
 * ★ 틀(머리말·본문 폭)은 **여기가 씌운다.** 모듈은 내용만 그린다.
 *   모듈이 제 머리말을 그리게 두면 모듈 화면만 nav 가 없어서 길을 잃고(실제로 리더보드가 그랬다),
 *   사이트 폭·여백을 고칠 때마다 모듈 전부를 따라 고쳐야 한다. 틀은 host 가, 내용은 모듈이.
 * ★ 더 구체적인 core 라우트(/streamers, /s/[slug], /fc/…)가 언제나 먼저다. 모듈이 core 주소를
 *   선언해도 core 화면을 덮지 못한다.
 */
type Props = {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

async function resolve(props: Props) {
  const hit = matchModuleRoute((await props.params).path);
  // FC 모듈은 FC 레이아웃 안의 마운트(app/fc/[...path])가 띄운다.
  const load = hit?.module.game === "lol" ? moduleUi(hit.module.name) : undefined;
  if (!hit || !load) return null;
  return { params: hit.params, searchParams: await props.searchParams, ui: await load() };
}

export async function generateMetadata(props: Props) {
  const r = await resolve(props);
  if (!r) return {};
  return r.ui.generateMetadata?.({ params: r.params, searchParams: r.searchParams, roleHref }) ?? {};
}

export default async function ModuleRoutePage(props: Props) {
  const r = await resolve(props);
  if (!r) notFound();
  const View = r.ui.default;
  return (
    <>
      <SiteHeader />
      <main className="arena-shell">
        <View params={r.params} searchParams={r.searchParams} roleHref={roleHref} />
      </main>
    </>
  );
}
