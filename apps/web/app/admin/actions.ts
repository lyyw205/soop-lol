"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addCareerEvent,
  createStreamer,
  deleteCareerEvent,
  linkAccount,
  setAccountVisibility,
  setMainAccount,
  unlinkAccount,
  updateStreamer,
  upsertRiotAccount,
} from "@soop-lol/core/lib/db/streamers";
import type { Confidence } from "@soop-lol/core/lib/db/types";
import { RiotApiError } from "@soop-lol/core/lib/riot/client";

// ★ ActionState/IDLE 은 lib/action-state.ts 에 있다.
//   `"use server"` 파일은 async 함수만 export 할 수 있어서, 상수를 여기 두면
//   빌드가 invalid-use-server-value 로 죽는다.
import type { ActionState } from "@/lib/action-state";
import { hasRiotKey, riot } from "@/lib/riot";

function text(form: FormData, key: string): string {
  return String(form.get(key) ?? "").trim();
}

function fail(message: string): ActionState {
  return { ok: false, message };
}

// ── 스트리머 ─────────────────────────────────────────────────────────

export async function createStreamerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const display_name = text(form, "display_name");
  // ★ 방송 채널 아이디다 (SOOP 방송국 아이디). 우리 키도, 라이엇 계정도 아니다.
  const channel_id = text(form, "channel_id");
  // SOOP 채널 아이디는 ASCII 라 slug 기본값으로 딱 맞다. 비면 직접 받는다.
  const slug = text(form, "slug") || channel_id;

  if (!display_name) return fail("스트리머 이름은 필수입니다.");
  if (!slug) return fail("slug(주소에 쓸 영문 아이디)가 필요합니다. SOOP 아이디를 넣어도 됩니다.");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) {
    return fail("slug 는 영문·숫자·하이픈·밑줄만 쓸 수 있습니다.");
  }

  const aliases = text(form, "aliases")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let created;
  try {
    created = await createStreamer({
      slug: slug.toLowerCase(),
      display_name,
      channel: channel_id ? { platform: "soop", channel_id } : undefined,
      aliases,
      is_pro: form.get("is_pro") === "on",
      note: text(form, "note") || null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("duplicate key")) return fail("이미 있는 slug 또는 채널 아이디입니다.");
    return fail(`등록 실패: ${message}`);
  }

  revalidatePath("/admin/streamers");
  redirect(`/admin/streamers/${created.id}`);
}

export async function updateStreamerAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const id = text(form, "id");
  if (!id) return fail("대상이 없습니다.");

  const updated = await updateStreamer(id, {
    display_name: text(form, "display_name"),
    team_name: text(form, "team_name") || null,
    note: text(form, "note") || null,
    is_pro: form.get("is_pro") === "on",
    visibility: form.get("visibility") === "hidden" ? "hidden" : "public",
    aliases: text(form, "aliases").split(",").map((s) => s.trim()).filter(Boolean),
  });

  // ★ RETURNING 으로 실제 갱신을 확인한다. "무조건 성공" 을 돌려주지 않는다.
  if (!updated) return fail("갱신된 행이 없습니다. 이미 삭제된 스트리머일 수 있습니다.");

  revalidatePath(`/admin/streamers/${id}`);
  return { ok: true, message: "저장했습니다." };
}

// ── 계정 매핑 ────────────────────────────────────────────────────────

/**
 * 계정 연결.
 *
 * Riot ID 를 넣으면 API 로 puuid 를 찾고, API 키가 없으면 puuid 직접 입력을 받는다.
 * (키 발급 전에도 명단 작업을 시작할 수 있어야 한다)
 *
 * ★ 근거가 없으면 core 의 linkAccount 가 거부한다. 여기서도 미리 막아 메시지를 낫게 준다.
 */
export async function linkAccountAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const streamerId = text(form, "streamer_id");
  const riotId = text(form, "riot_id");
  const manualPuuid = text(form, "puuid");
  const evidenceUrl = text(form, "evidence_url");
  const evidenceNote = text(form, "evidence_note");

  if (!streamerId) return fail("대상 스트리머가 없습니다.");
  if (!evidenceUrl && !evidenceNote) {
    return fail("근거가 필요합니다. 본인이 밝힌 클립·공지 URL 이나 확인 메모를 남겨주세요.");
  }

  let puuid = manualPuuid;
  let gameName: string | null = null;
  let tagLine: string | null = null;
  let summonerId: string | null = null;
  let summonerLevel: number | null = null;
  let profileIconId: number | null = null;

  if (!puuid) {
    if (!riotId) return fail("Riot ID(닉네임#태그) 또는 puuid 중 하나는 있어야 합니다.");
    if (!hasRiotKey()) {
      return fail("RIOT_API_KEY 가 없어 Riot ID 조회를 못 합니다. puuid 를 직접 넣거나 키를 설정하세요.");
    }
    const hash = riotId.lastIndexOf("#");
    if (hash <= 0 || hash === riotId.length - 1) {
      return fail("Riot ID 는 `닉네임#태그` 형식이어야 합니다. 예: 홍길동#KR1");
    }
    const name = riotId.slice(0, hash);
    const tag = riotId.slice(hash + 1);

    try {
      const account = await riot().accountByRiotId(name, tag);
      if (!account) return fail(`Riot ID 를 찾을 수 없습니다: ${riotId}`);
      puuid = account.puuid;
      gameName = account.gameName ?? name;
      tagLine = account.tagLine ?? tag;

      const summoner = await riot().summonerByPuuid(puuid);
      if (summoner) {
        summonerId = summoner.id ?? null;
        summonerLevel = summoner.summonerLevel ?? null;
        profileIconId = summoner.profileIconId ?? null;
      }
    } catch (e) {
      if (e instanceof RiotApiError && e.isAuthProblem) {
        return fail("Riot API 키가 만료되었거나 권한이 없습니다. Development 키는 24시간마다 죽습니다.");
      }
      return fail(`Riot API 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const confidence = (text(form, "confidence") || "unverified") as Confidence;

  try {
    await upsertRiotAccount({
      puuid,
      game_name: gameName,
      tag_line: tagLine,
      summoner_id: summonerId,
      summoner_level: summonerLevel,
      profile_icon_id: profileIconId,
    });
    await linkAccount({
      streamer_id: streamerId,
      puuid,
      label: text(form, "label") || null,
      is_main: form.get("is_main") === "on",
      confidence,
      evidence: {
        source: (text(form, "evidence_source") || "manual") as never,
        url: evidenceUrl || undefined,
        note: evidenceNote || undefined,
      },
    });
  } catch (e) {
    return fail(`연결 실패: ${e instanceof Error ? e.message : String(e)}`);
  }

  revalidatePath(`/admin/streamers/${streamerId}`);
  return { ok: true, message: `연결했습니다. 백필 대기열에 올렸습니다. (${gameName ?? puuid.slice(0, 12)}…)` };
}

export async function setMainAccountAction(form: FormData): Promise<void> {
  const streamerId = text(form, "streamer_id");
  const puuid = text(form, "puuid");
  if (!streamerId || !puuid) return;
  await setMainAccount(streamerId, puuid);
  revalidatePath(`/admin/streamers/${streamerId}`);
}

export async function toggleAccountVisibilityAction(form: FormData): Promise<void> {
  const streamerId = text(form, "streamer_id");
  const puuid = text(form, "puuid");
  const next = text(form, "next_visibility") === "hidden" ? "hidden" : "public";
  if (!streamerId || !puuid) return;
  await setAccountVisibility(streamerId, puuid, next);
  revalidatePath(`/admin/streamers/${streamerId}`);
}

export async function unlinkAccountAction(form: FormData): Promise<void> {
  const streamerId = text(form, "streamer_id");
  const puuid = text(form, "puuid");
  if (!streamerId || !puuid) return;
  await unlinkAccount(streamerId, puuid);
  revalidatePath(`/admin/streamers/${streamerId}`);
}

// ── 커리어 (수기) ────────────────────────────────────────────────────

export async function addCareerEventAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const streamerId = text(form, "streamer_id");
  const title = text(form, "title");
  if (!streamerId || !title) return fail("대회/활동 이름은 필수입니다.");

  await addCareerEvent({
    streamer_id: streamerId,
    title,
    role: text(form, "role") || null,
    team_name: text(form, "team_name") || null,
    placement: text(form, "placement") || null,
    date_from: text(form, "date_from") || null,
    date_to: text(form, "date_to") || null,
    source_url: text(form, "source_url") || null,
  });

  revalidatePath(`/admin/streamers/${streamerId}`);
  return { ok: true, message: "커리어를 추가했습니다." };
}

export async function deleteCareerEventAction(form: FormData): Promise<void> {
  const id = text(form, "id");
  const streamerId = text(form, "streamer_id");
  if (!id) return;
  await deleteCareerEvent(id);
  revalidatePath(`/admin/streamers/${streamerId}`);
}
