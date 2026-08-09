import { notFound } from "next/navigation";

import { moduleByName } from "@soop-lol/modules/registry";

/**
 * 모듈 UI 마운트 지점.
 *
 * core 웹은 어떤 모듈이 있는지 **모른다**. 생성된 등록부만 보고 렌더한다.
 * 모듈 디렉터리를 지우고 `npm run modules:sync` 를 돌리면 등록부에서 빠지고,
 * 이 라우트는 404 가 된다. core 코드는 한 줄도 안 고친다.
 */
export default async function ModulePage({ params }: { params: Promise<{ module: string }> }) {
  const { module: name } = await params;
  const mod = moduleByName(name);
  if (!mod?.ui) notFound();
  const { default: View } = await mod.ui();
  return <View />;
}
