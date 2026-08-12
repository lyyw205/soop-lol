import { notFound } from "next/navigation";

import { moduleByName } from "@soop-lol/modules/registry";
import { moduleUi } from "@soop-lol/modules/ui";

import { SiteHeader } from "../../../components/public";

/**
 * 모듈 UI 마운트 지점.
 *
 * core 웹은 어떤 모듈이 있는지 **모른다**. 생성된 등록부만 보고 렌더한다.
 * 모듈 디렉터리를 지우고 `npm run modules:sync` 를 돌리면 등록부에서 빠지고,
 * 이 라우트는 404 가 된다. core 코드는 한 줄도 안 고친다.
 *
 * ★ 틀(머리말·본문 폭)은 **여기가 씌운다.** 모듈은 내용만 그린다.
 *   모듈이 제 머리말을 그리게 두면 두 가지가 같이 망가진다 — 모듈 화면만 nav 가
 *   없어서 길을 잃고(실제로 리더보드가 그랬다), 사이트 폭·여백을 고칠 때마다
 *   모듈 전부를 따라 고쳐야 한다. 모듈이 apps/web 컴포넌트를 import 하는 건
 *   경계 위반이라 답이 아니다. 틀은 host 가, 내용은 모듈이.
 */
export default async function ModulePage({
  params, searchParams,
}: {
  params: Promise<{ module: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { module: name } = await params;
  const mod = moduleByName(name);
  const load = mod ? moduleUi(name) : undefined;
  if (!mod || !load) notFound();
  const { default: View } = await load();
  // ★ 쿼리는 그대로 넘긴다. host 는 그 안에 뭐가 들었는지 모른다 —
  //   모듈마다 라우트를 파면 core 가 모듈 이름을 알게 되고 그게 역방향 의존이다.
  const sp = await searchParams;
  return (
    <>
      <SiteHeader />
      {/* ★ 모듈 화면은 표·타임라인이 많아 코어 화면(max-w-5xl)보다 넓게 준다.
          폭도 host 정책이다 — 모듈마다 제각각 잡으면 사이트가 들쭉날쭉해진다. */}
      <main className="mx-auto box-border w-full max-w-[1120px] px-6 py-10">
        <View searchParams={sp} />
      </main>
    </>
  );
}
