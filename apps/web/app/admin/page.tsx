import Link from "next/link";

import { adminCounts } from "@soop-lol/core/lib/db/streamers";

import { Card, StatTile, Tag } from "@/components/ui";
import { hasRiotKey } from "@/lib/riot";
import { SetupNotice } from "@/components/admin/SetupNotice";

export const dynamic = "force-dynamic";

export default async function AdminDashboard() {
  let counts;
  try {
    counts = await adminCounts();
  } catch (e) {
    return <SetupNotice error={e} />;
  }

  const keyReady = hasRiotKey();

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="스트리머" value={counts.streamers} />
        <StatTile
          label="연결된 계정"
          value={counts.accounts}
          hint={`확인됨 ${counts.verified_accounts}개`}
        />
        <StatTile label="수집된 경기" value={counts.matches.toLocaleString("ko-KR")} />
        <StatTile
          label="스트리머 조우"
          value={counts.encounters.toLocaleString("ko-KR")}
          hint="상대전적의 원천"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="티어 스냅샷" value={counts.rank_snapshots.toLocaleString("ko-KR")} />
        <StatTile label="백필 대기" value={counts.backfill_pending} hint="아직 과거를 다 못 긁은 계정" />
        <StatTile label="후보 대기" value={counts.pending_candidates} hint="승인 대기 중인 계정 후보" />
      </div>

      <Card
        title="지금 해야 할 일"
        description="데이터가 흐르기 시작하려면 아래가 순서대로 채워져야 합니다."
      >
        <ol className="space-y-3 text-sm">
          <Step
            done={counts.streamers > 0}
            label="스트리머 등록"
            detail="관리할 스트리머를 먼저 넣습니다."
            href="/admin/streamers"
          />
          <Step
            done={counts.accounts > 0}
            label="라이엇 계정 연결"
            detail="근거를 남기면서 puuid 를 붙입니다. 연결하는 순간 백필 대기열에 올라갑니다."
            href="/admin/streamers"
          />
          <Step
            done={keyReady}
            label="RIOT_API_KEY 설정"
            detail={
              keyReady
                ? "설정되어 있습니다."
                : "키가 없으면 Riot ID 조회와 수집이 전부 멈춥니다. Development 키는 24시간마다 만료됩니다."
            }
          />
          <Step
            done={counts.rank_snapshots > 0}
            label="워커 가동 (티어 스냅샷)"
            detail="★ 과거 티어는 API 에 없습니다. 오늘 안 쌓으면 오늘치는 영원히 구멍입니다."
          />
        </ol>
      </Card>
    </div>
  );
}

function Step({
  done,
  label,
  detail,
  href,
}: {
  done: boolean;
  label: string;
  detail: string;
  href?: string;
}) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 select-none text-sm ${done ? "text-win" : "text-ink-400"}`}>
        {done ? "●" : "○"}
      </span>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink-200">{label}</span>
          {!done && <Tag tone="warn">대기</Tag>}
          {href && (
            <Link href={href} className="text-xs text-accent-500 hover:underline">
              바로가기
            </Link>
          )}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-ink-400">{detail}</p>
      </div>
    </li>
  );
}
