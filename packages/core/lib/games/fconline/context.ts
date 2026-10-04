import type postgres from "postgres";
import { db } from "../../db/client.ts";

type Tx = postgres.TransactionSql;

/**
 * 사람(admin)이 이 행사에서 뺀 경기인가 — (행사, 경기)의 마지막 결정이 admin 의 exclude 다(0034).
 * ★ 행사 연결은 경로가 여럿이다(단독 연결·시리즈를 통한 연결·직접 연결 명령). 어느 경로든 저장 전에 이 검사를 거친다 —
 *   한 경로만 검사하면 다른 경로가 사람의 제외를 조용히 되살린다.
 */
export async function isHumanExcluded(tx: Tx, eventId: string, matchId: string): Promise<boolean> {
  const [last] = await tx<{ decision: string; created_by: string }[]>`
    SELECT decision, created_by FROM fco_event_match_decision
     WHERE event_id = ${eventId}::uuid AND match_id = ${matchId}
     ORDER BY created_at DESC LIMIT 1`;
  return last?.decision === "exclude" && last.created_by === "admin";
}

/**
 * 이 시리즈의 세트 중 사람이 이 행사에서 뺀 경기가 있나. 시리즈에 행사를 붙이면 세트의 행사는 시리즈가 정하므로(0027)
 * 그 세트가 되살아난다 — 다른 세트를 고치다가 제외된 경기가 돌아오는 경로다. 있으면 그 경기 id 를 돌려준다.
 */
export async function humanExcludedInSeries(tx: Tx, seriesId: string, eventId: string): Promise<string | null> {
  const rows = await tx<{ match_id: string }[]>`
    SELECT m.match_id FROM match m
      JOIN LATERAL (SELECT decision, created_by FROM fco_event_match_decision d
                     WHERE d.event_id = ${eventId}::uuid AND d.match_id = m.match_id
                     ORDER BY d.created_at DESC LIMIT 1) last ON true
     WHERE m.series_id = ${seriesId} AND m.game_code = 'fconline'
       AND last.decision = 'exclude' AND last.created_by = 'admin'
     LIMIT 1`;
  return rows[0]?.match_id ?? null;
}

/**
 * FC 경기 맥락의 단일 반영 경로 (0032, FCO-MATCH-CONTEXT-SKILL-PLAN 데이터 계약 3·4).
 *
 * 현재 맥락의 파생 규칙은 0032 주석과 같다 — event 연결 > 최신 context 행 > 미조사.
 * CK·대회 결론은 event 를 만들어 연결하는 것이고, 이 모듈의 judgment 에는 없다.
 */

export type FcoContextJudgment = "casual" | "unresolved";
export type FcoContextStatus = "event" | FcoContextJudgment | "uninvestigated";

export type FcoEvidenceRole = "pre" | "start" | "end" | "post" | "result";

export interface FcoEvidenceInput {
  /** 멱등 재전송 키. 예: 'vod:207643193@1479', 'notice:pick-182785'. */
  evidence_key: string;
  kind: "vod_frame" | "chat" | "audio" | "notice" | "url";
  vod_title_no?: number | null;
  channel_id?: string | null;
  /** VOD 전체 초 — ck:probe 와 같은 축. */
  at_sec?: number | null;
  end_sec?: number | null;
  url?: string | null;
  /** 조사가 실제로 연 프레임 파일 (out/ck/<vod>/g<전체초>.jpg). 검수 화면이 띄워 대조한다. */
  frame_path?: string | null;
  /** 경기 흐름의 어느 장면인가(0036). result 는 검수 화면이 먼저 띄운다. */
  role?: FcoEvidenceRole | null;
  /** 본 것. */
  observed: string;
  /** 그래서 어떻게 봤나. 관찰과 섞지 않는다. */
  why?: string | null;
}

export interface FcoContextInput {
  /**
   * 경기 참조 — 넥슨 경기 번호(provider_match_id) **또는 내부 match_id**(`fco:…`·`fcs:<VOD>@<초>`).
   * 화면 경기(VOD 결과 화면에서 읽은 경기)는 넥슨 번호가 없어 내부 id 로만 찾는다. 두 값은 겹치지 않는다.
   */
  provider_match_id: string;
  expectedVersion?: number;
  /** 없으면 근거만 쌓는다 — 결론 없이 중간 반영해도 된다. */
  conclusion?: "casual" | "unresolved" | "event";
  /** casual/unresolved 의 근거 또는 남은 질문. 필수 — 빈 도장은 못 찍는다. */
  note?: string;
  event?: {
    slug: string;
    name: string;
    kind: "ck" | "scrim" | "tournament" | "showmatch" | "other";
    organizer?: string | null;
    /** 확인 근거 URL. 필수 — 근거 없는 행사 연결은 받지 않는다. */
    source_url: string;
  };
  /**
   * 다전제. 같은 두 사람이 연속 세트로 한 판의 승부를 가린 경우에만 쓴다 —
   * **상대가 바뀌면 시리즈가 아니라 대회(event)다.** 세트마다 이 블록을 준다.
   * ⚠ best_of 는 근거 없이 못 넣는다. 「연속 3경기니까 Bo3」 는 추측이다.
   */
  series?: {
    /** 시리즈 정본 id. 예: `fc-sisik-cup-2026-09-20:kimmingyo-doochiwa`. */
    id: string;
    /** 이 경기가 그 시리즈의 몇 번째 세트인가 (1부터). */
    game_no: number;
    /** 3판2선승이면 3. 모르면 비운다 — 모른다와 단판은 다르다. */
    best_of?: number | null;
    /** best_of 를 확정한 화면·규정. best_of 를 줄 때만 필수(DB 도 막는다). */
    best_of_evidence?: string | null;
  };
  evidences?: FcoEvidenceInput[];
}

export interface FcoContextOutcome {
  provider_match_id: string;
  /** 실제로 한 일 (dry-run 이면 했을 일). */
  actions: string[];
  /** ⏭ 건너뛴 것과 사유. 성공으로 세지 않는다. */
  skipped: string[];
}

const ROLLBACK = Symbol("dry-run rollback");

export async function applyFcoMatchContext(
  input: FcoContextInput,
  /** relink: 이미 붙은 행사를 **사람이 화면에서 의도적으로** 바꿀 때만 (admin 전용). */
  opts: { createdBy?: "auto" | "admin"; dryRun?: boolean; relink?: boolean; transaction?: Tx } = {},
): Promise<FcoContextOutcome> {
  const createdBy = opts.createdBy ?? "auto";
  const out: FcoContextOutcome = { provider_match_id: input.provider_match_id, actions: [], skipped: [] };
  const sql = db();
  try {
    const run = async (tx: Tx) => {
      const games = await tx<{ match_id: string; event_id: string | null; series_id: string | null; series_event_id: string | null }[]>`
        SELECT m.match_id, m.event_id, m.series_id, ms.event_id AS series_event_id
          FROM match m
          LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
          LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
         WHERE (d.provider_match_id = ${input.provider_match_id} OR m.match_id = ${input.provider_match_id})
           AND m.game_code = 'fconline'
         FOR UPDATE OF m
      `;
      const game = games[0];
      if (!game) throw new Error(`수집되지 않은 경기입니다: ${input.provider_match_id} — 먼저 FC 수집을 돌린다`);
      await assertFcoContextVersion(tx, game.match_id, input.expectedVersion);
      const linkedEventId = game.series_event_id ?? game.event_id;

      // ── 근거 — 결론과 무관하게 먼저 쌓는다. 판단이 바뀌어도 근거는 남는다.
      for (const ev of input.evidences ?? []) {
        if (!ev.evidence_key?.trim()) throw new Error("evidence_key 가 없다 — 멱등 재전송 키는 조사자가 정한다");
        if (!ev.observed?.trim()) throw new Error(`근거 '${ev.evidence_key}': observed(본 것)가 없다`);
        if (ev.kind === "vod_frame" && (ev.vod_title_no == null || ev.at_sec == null)) {
          throw new Error(`근거 '${ev.evidence_key}': vod_frame 은 vod_title_no 와 at_sec(전체 초)가 필요하다`);
        }
        if (ev.kind === "url" && !ev.url) throw new Error(`근거 '${ev.evidence_key}': url 종류는 url 이 필요하다`);
        const existing = await tx<{ created_by: string; observed: string; why: string | null; frame_path: string | null; role: string | null }[]>`
          SELECT created_by, observed, why, frame_path, role FROM fco_context_evidence
           WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}
        `;
        if (!existing[0]) {
          await tx`
            INSERT INTO fco_context_evidence
              (match_id, evidence_key, kind, vod_title_no, channel_id, at_sec, end_sec, url, frame_path, role, observed, why, created_by)
            VALUES (${game.match_id}, ${ev.evidence_key}, ${ev.kind}, ${ev.vod_title_no ?? null},
                    ${ev.channel_id ?? null}, ${ev.at_sec ?? null}, ${ev.end_sec ?? null}, ${ev.url ?? null},
                    ${ev.frame_path ?? null}, ${ev.role ?? null}, ${ev.observed}, ${ev.why ?? null}, ${createdBy})
          `;
          out.actions.push(`근거 저장 ${ev.evidence_key}`);
        } else if (existing[0].observed === ev.observed && (existing[0].why ?? null) === (ev.why ?? null)
          && (existing[0].frame_path ?? null) === (ev.frame_path ?? null)) {
          // 내용이 같고 역할만 비어 있으면 채운다 — 0036 이전 근거에 역할을 다는 길이다(덮어쓰기 아님).
          if (ev.role && !existing[0].role) {
            await tx`UPDATE fco_context_evidence SET role = ${ev.role}
                      WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}`;
            out.actions.push(`근거 역할 채움 ${ev.evidence_key} → ${ev.role}`);
          } else {
            out.skipped.push(`근거 ${ev.evidence_key} — 이미 같은 내용`);
          }
        } else if (createdBy === "admin") {
          await tx`
            UPDATE fco_context_evidence
               SET observed = ${ev.observed}, why = ${ev.why ?? null},
                   vod_title_no = ${ev.vod_title_no ?? null}, channel_id = ${ev.channel_id ?? null},
                   at_sec = ${ev.at_sec ?? null}, end_sec = ${ev.end_sec ?? null}, url = ${ev.url ?? null},
                   frame_path = ${ev.frame_path ?? null}, role = ${ev.role ?? null},
                   created_by = 'admin'
             WHERE match_id = ${game.match_id} AND evidence_key = ${ev.evidence_key}
          `;
          out.actions.push(`근거 교정 ${ev.evidence_key} (admin)`);
        } else {
          out.skipped.push(`근거 ${ev.evidence_key} — 이미 있고 내용이 다르다. 교정은 admin 경로만`);
        }
      }

      // ── 결론
      if (input.conclusion === "casual" || input.conclusion === "unresolved") {
        const note = input.note?.trim();
        if (!note) throw new Error(`'${input.conclusion}' 에는 note(근거/남은 질문)가 필수다`);
        if (input.conclusion === "casual" && linkedEventId) {
          throw new Error("event 연결이 이미 결론이다 — 단순 친선 판단과 모순된다. 연결을 먼저 확인하라");
        }
        const latest = await tx<{ judgment: string; note: string; created_by: string }[]>`
          SELECT judgment, note, created_by FROM fco_match_context
           WHERE match_id = ${game.match_id} ORDER BY created_at DESC LIMIT 1
        `;
        if (latest[0] && latest[0].judgment === input.conclusion && latest[0].note === note) {
          out.skipped.push("판단 — 이미 같은 내용 (멱등)");
        } else if (latest[0] && latest[0].created_by === "admin" && createdBy === "auto") {
          out.skipped.push("판단 — 검수(admin) 판단이 있어 자동 반영이 덮지 않는다");
        } else {
          await tx`
            INSERT INTO fco_match_context (match_id, judgment, note, created_by)
            VALUES (${game.match_id}, ${input.conclusion}, ${note}, ${createdBy})
          `;
          out.actions.push(`판단 기록 ${input.conclusion}`);
        }
      }

      // ── 행사 — 시리즈가 있으면 행사의 주인은 시리즈다(0027 match_series_owns_event).
      let eventId: string | null = null;
      if (input.conclusion === "event") {
        const meta = input.event;
        if (!meta?.slug || !meta.name || !meta.kind) throw new Error("event 결론에는 event{slug,name,kind}가 필수다");
        if (!meta.source_url?.trim()) throw new Error("행사 연결에는 확인 근거 URL(event.source_url)이 필수다");
        if (game.series_id && !input.series) {
          throw new Error("시리즈에 속한 경기다 — 행사는 match_series.event_id 가 정본이므로 series 블록과 함께 보내라");
        }
        const existing = await tx<{ id: string; name: string; kind: string; game_code: string }[]>`
          SELECT id, name, kind, game_code FROM event WHERE slug = ${meta.slug}
        `;
        if (existing[0]) {
          if (existing[0].game_code !== "fconline") {
            throw new Error(`slug '${meta.slug}' 는 ${existing[0].game_code} 행사가 쓰고 있다`);
          }
          if (existing[0].name !== meta.name) {
            throw new Error(`slug 충돌 — 기존 행사 이름은 '${existing[0].name}' 이다. 덮어쓰지 않는다. 이름을 바꾸려면 admin 이 event 를 직접 고친다`);
          }
          if (existing[0].kind !== meta.kind) {
            throw new Error(`kind 충돌 — 기존 행사는 '${existing[0].kind}' 다. 행사 성격 변경은 별도로 확인해서 한다`);
          }
          eventId = existing[0].id;
          await tx`UPDATE event SET source_url = COALESCE(event.source_url, ${meta.source_url}),
                                    organizer = COALESCE(event.organizer, ${meta.organizer ?? null})
                    WHERE id = ${eventId}::uuid`;
        } else {
          const rows = await tx<{ id: string }[]>`
            INSERT INTO event (slug, name, kind, game_code, organizer, source_url)
            VALUES (${meta.slug}, ${meta.name}, ${meta.kind}, 'fconline', ${meta.organizer ?? null}, ${meta.source_url})
            RETURNING id
          `;
          eventId = rows[0].id;
          out.actions.push(`행사 생성 ${meta.slug} (${meta.kind})`);
        }
        // ★ 사람이 이 행사에서 뺀 경기는 자동 조사가 다시 붙이지 못한다(0034).
        const [lastDecision] = await tx<{ decision: string; created_by: string }[]>`
          SELECT decision, created_by FROM fco_event_match_decision
           WHERE event_id = ${eventId}::uuid AND match_id = ${game.match_id}
           ORDER BY created_at DESC LIMIT 1
        `;
        const humanExcluded = lastDecision?.decision === "exclude" && lastDecision.created_by === "admin";
        if (humanExcluded && createdBy !== "admin") {
          out.skipped.push("행사 연결 — 사람이 이 행사에서 제외한 경기다. 자동으로 다시 붙이지 않는다");
        } else if (!input.series) {
          if (game.event_id && game.event_id !== eventId && !(opts.relink && createdBy === "admin")) {
            throw new Error("경기가 이미 다른 행사에 연결돼 있다 — 바꾸려면 먼저 기존 연결을 확인하라");
          }
          if (game.event_id === eventId) {
            out.skipped.push("행사 연결 — 이미 연결됨 (멱등)");
          } else {
            if (game.event_id) {
              // 옮기면 옛 행사에서는 빠진 것이다 — 결정 이력이 공개 연결과 어긋나지 않게 남긴다.
              await tx`INSERT INTO fco_event_match_decision (event_id, match_id, decision, note, created_by)
                       VALUES (${game.event_id}::uuid, ${game.match_id}, 'exclude', ${`다른 행사(${meta.slug})로 옮김`}, ${createdBy})`;
            }
            await tx`UPDATE match SET event_id = ${eventId}::uuid, source_url = ${meta.source_url}
                      WHERE match_id = ${game.match_id}`;
            out.actions.push(`행사 연결 ${meta.slug}`);
          }
        }
        // 연결 결과를 결정 이력에도 남긴다 — 화면은 이 행으로 포함/제외를 가른다.
        if (!(humanExcluded && createdBy !== "admin") && !(lastDecision?.decision === "include" && (lastDecision.created_by === createdBy || lastDecision.created_by === "admin"))) {
          await tx`INSERT INTO fco_event_match_decision (event_id, match_id, decision, created_by)
                   VALUES (${eventId}::uuid, ${game.match_id}, 'include', ${createdBy})`;
        }
      }

      // ── 시리즈 — 세트를 한 판으로 묶는다. 승패는 저장하지 않고 세트에서 파생한다(series.ts).
      if (input.series) {
        const meta = input.series;
        if (!meta.id?.trim()) throw new Error("series.id 가 필요하다 — 시리즈의 정본 키다");
        if (!Number.isInteger(meta.game_no) || meta.game_no < 1) {
          throw new Error("series.game_no 는 1 이상 정수다 (이 경기가 몇 번째 세트인가)");
        }
        if (meta.best_of != null) {
          if (!Number.isInteger(meta.best_of) || meta.best_of < 1 || meta.best_of % 2 === 0) {
            throw new Error("best_of 는 홀수 양수다 (Bo1·Bo3·Bo5…)");
          }
          if (!meta.best_of_evidence?.trim()) {
            throw new Error("best_of 에는 근거가 필수다 — 화면·공지에서 읽은 것을 적는다. 연속 경기 수로 추측하지 않는다");
          }
        }

        // 같은 대진인지 — 상대가 바뀌면 다전제가 아니다. 대회면 event 로 묶어야 한다.
        // ★ 사람 비교는 fco_participant_key(스트리머 → 계정 → 화면 이름, 0054)로 한다. ouid 로 비교하면 화면 경기(ouid 없음)가
        //   같은 사람인데도 "다른 대진"이 되고, NULL 끼리는 array_agg 에서 같은 값처럼 합쳐진다.
        const [mine] = await tx<{ ouids: string[] }[]>`
          SELECT array_agg(fco_participant_key(ouid, streamer_id, nickname) ORDER BY fco_participant_key(ouid, streamer_id, nickname)) AS ouids
            FROM fco_match_participant WHERE match_id = ${game.match_id}
        `;
        const siblings = await tx<{ match_id: string; game_no: number | null; ouids: string[] }[]>`
          SELECT m.match_id, m.series_game_no AS game_no,
                 array_agg(fco_participant_key(p.ouid, p.streamer_id, p.nickname) ORDER BY fco_participant_key(p.ouid, p.streamer_id, p.nickname)) AS ouids
            FROM match m JOIN fco_match_participant p ON p.match_id = m.match_id
           WHERE m.series_id = ${meta.id} AND m.game_code = 'fconline' AND m.match_id <> ${game.match_id}
           GROUP BY m.match_id, m.series_game_no
        `;
        for (const sibling of siblings) {
          if (sibling.ouids.join("|") !== (mine?.ouids ?? []).join("|")) {
            throw new Error(`시리즈 '${meta.id}' 에 다른 대진이 들어 있다 — 상대가 바뀌면 같은 다전제가 아니다. 대회라면 event 로 묶어라`);
          }
          if (sibling.game_no === meta.game_no) {
            throw new Error(`시리즈 '${meta.id}' 의 ${meta.game_no}세트는 이미 ${sibling.match_id} 다`);
          }
        }

        const [known] = await tx<{ event_id: string | null; best_of: number | null; best_of_evidence: string | null }[]>`
          SELECT event_id, best_of, best_of_evidence FROM match_series
           WHERE id = ${meta.id} AND game_code = 'fconline'
        `;
        // ★ 사람의 제외는 시리즈를 통해서도 우회되지 않는다(근거는 위에서 이미 저장했다 — 보존).
        //   (1) 이 경기가 붙으려는 행사(이번 호출의 행사 또는 시리즈가 이미 가진 행사)에서 사람이 이 경기를 뺐다
        //   (2) 이번 호출이 시리즈에 행사를 처음 붙이는데, 같은 시리즈의 다른 세트를 사람이 그 행사에서 뺐다
        let seriesBlock: string | null = null;
        if (createdBy !== "admin") {
          for (const ev of new Set([eventId, known?.event_id].filter((x): x is string => !!x))) {
            if (await isHumanExcluded(tx, ev, game.match_id)) seriesBlock = "사람이 이 행사에서 제외한 경기다";
          }
        }
        if (!seriesBlock && eventId && !known?.event_id) {
          const excluded = known || game.series_id === meta.id ? await humanExcludedInSeries(tx, meta.id, eventId) : null;
          if (excluded) seriesBlock = `같은 시리즈의 ${excluded} 를 사람이 이 행사에서 제외했다 — 시리즈에 행사를 붙이면 되살아난다`;
        }
        if (seriesBlock) {
          out.skipped.push(`시리즈 ${meta.id} ${meta.game_no}세트 — ${seriesBlock}. 자동으로 연결하지 않는다`);
        } else {
        if (!known) {
          await tx`
            INSERT INTO match_series (id, game_code, event_id, best_of, best_of_evidence)
            VALUES (${meta.id}, 'fconline', ${eventId}, ${meta.best_of ?? null}, ${meta.best_of_evidence ?? null})
          `;
          out.actions.push(`시리즈 생성 ${meta.id}${meta.best_of ? ` (Bo${meta.best_of})` : ""}`);
        } else {
          // 충돌은 확인 대상이지 덮어쓰기 대상이 아니다 — 비어 있던 값만 채운다.
          if (meta.best_of != null && known.best_of != null && known.best_of !== meta.best_of) {
            throw new Error(`시리즈 '${meta.id}' 는 이미 Bo${known.best_of} 다 (근거: ${known.best_of_evidence}). 바꾸려면 확인이 먼저다`);
          }
          if (eventId && known.event_id && known.event_id !== eventId) {
            throw new Error(`시리즈 '${meta.id}' 가 이미 다른 행사에 연결돼 있다`);
          }
          if ((eventId && !known.event_id) || (meta.best_of != null && known.best_of == null)) {
            await tx`
              UPDATE match_series
                 SET event_id = COALESCE(event_id, ${eventId}),
                     best_of = COALESCE(best_of, ${meta.best_of ?? null}),
                     best_of_evidence = COALESCE(best_of_evidence, ${meta.best_of_evidence ?? null}),
                     updated_at = now()
               WHERE id = ${meta.id} AND game_code = 'fconline'
            `;
            out.actions.push(`시리즈 보강 ${meta.id}`);
          }
        }

        if (game.series_id && game.series_id !== meta.id) {
          throw new Error(`이 경기는 이미 시리즈 '${game.series_id}' 에 속해 있다`);
        }
        if (game.series_id === meta.id) {
          out.skipped.push(`시리즈 ${meta.id} ${meta.game_no}세트 — 이미 연결됨 (멱등)`);
        } else {
          // event 의 주인은 시리즈다 — 세트의 event_id 는 비운다(match_series_owns_event).
          await tx`
            UPDATE match SET series_id = ${meta.id}, series_game_no = ${meta.game_no}, event_id = NULL
             WHERE match_id = ${game.match_id}
          `;
          out.actions.push(`시리즈 연결 ${meta.id} ${meta.game_no}세트`);
        }
        }
      }

      if (opts.dryRun) throw ROLLBACK;
    };
    if (opts.transaction) await run(opts.transaction); else await sql.begin(run);
  } catch (e) {
    if (e !== ROLLBACK) throw e;
    out.actions = out.actions.map((a) => `(dry-run) ${a}`);
  }
  return out;
}

/** Check the exact context snapshot while holding the match lock. CLI callers may omit the token. */
async function assertFcoContextVersion(tx: Tx, matchId: string, expected?: number) {
  const [row] = await tx<{ context_review_version: number }[]>`
    SELECT context_review_version FROM match WHERE match_id = ${matchId} AND game_code = 'fconline' FOR UPDATE`;
  if (!row) throw new Error("경기를 찾지 못했습니다.");
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0 || row.context_review_version !== expected)) {
    throw new Error("대회·분류 정보가 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
  }
}

/** One transaction for the entire selection: a failure never leaves a partially classified session. */
export async function applyFcoMatchContexts(inputs: FcoContextInput[], opts: { relink?: boolean } = {}) {
  if (!inputs.length) throw new Error("선택한 경기가 없습니다.");
  return db().begin(async tx => {
    // Acquire and validate all rows first: updating one series may change sibling context versions.
    for (const input of [...inputs].sort((a, b) => a.provider_match_id.localeCompare(b.provider_match_id))) {
      const [m] = await tx<{ match_id: string }[]>`
        SELECT m.match_id FROM match m LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
         WHERE m.game_code = 'fconline' AND (m.match_id = ${input.provider_match_id} OR d.provider_match_id = ${input.provider_match_id}) FOR UPDATE OF m`;
      if (!m) throw new Error("선택한 경기를 찾지 못했습니다.");
      await assertFcoContextVersion(tx, m.match_id, input.expectedVersion);
    }
    const out: FcoContextOutcome = { provider_match_id: inputs[0].provider_match_id, actions: [], skipped: [] };
    for (const input of inputs) {
      const next = await applyFcoMatchContext({ ...input, expectedVersion: undefined }, { ...opts, createdBy: "admin", transaction: tx });
      out.actions.push(...next.actions); out.skipped.push(...next.skipped);
    }
    return out;
  });
}

// ── 조회 ─────────────────────────────────────────────────────────────

export interface FcoContextQueueRow {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  players: string;
  status: FcoContextStatus;
  event_name: string | null;
  event_kind: string | null;
  judgment_note: string | null;
  /** 최신 판단의 주체. 'auto' 면 승인 대기 후보다. */
  judgment_by: string | null;
  /** 대회·분류 판단을 확인했나 (match.context_review_completed_at). 조사 완료와는 별개다. */
  confirmed: boolean;
  evidence_count: number;
}

/**
 * 공개 스트리머 간 1:1 경기의 맥락 큐. 미조사가 곧 조사 후보다.
 * ⚠ status 는 0032 파생 규칙 그대로다. 여기서 다른 우선순위를 만들지 않는다.
 */
export async function listFcoContextQueue(
  opts: { from?: string; to?: string; streamer?: string; status?: FcoContextStatus } = {},
): Promise<FcoContextQueueRow[]> {
  const sql = db();
  const rows = await sql<{
    provider_match_id: string; match_id: string; played_at: string; mode_key: string | null;
    players: string; event_name: string | null; event_kind: string | null;
    judgment: string | null; judgment_note: string | null; judgment_by: string | null;
    confirmed: boolean; evidence_count: number;
  }[]>`
    SELECT d.provider_match_id, m.match_id, m.game_creation AS played_at, m.mode_key,
           string_agg(s.slug || '(' || p.outcome || ' ' || coalesce(coalesce(p.score_display, p.goals)::text, '?') || ')',
                      ' vs ' ORDER BY p.side_no) AS players,
           e.name AS event_name, e.kind AS event_kind,
           ctx.judgment, ctx.note AS judgment_note, ctx.created_by AS judgment_by,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           (SELECT count(*)::int FROM fco_context_evidence fe WHERE fe.match_id = m.match_id) AS evidence_count
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      JOIN fco_match_participant p ON p.match_id = m.match_id
      JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
      LEFT JOIN LATERAL (
        SELECT judgment, note, created_by FROM fco_match_context c
         WHERE c.match_id = m.match_id ORDER BY created_at DESC LIMIT 1
      ) ctx ON true
     WHERE m.game_code = 'fconline'
       AND (${opts.from ?? null}::text IS NULL OR m.game_creation >= (${opts.from ?? null}::date::timestamp AT TIME ZONE 'Asia/Seoul'))
       AND (${opts.to ?? null}::text IS NULL OR m.game_creation < ((${opts.to ?? null}::date + interval '1 day')::timestamp AT TIME ZONE 'Asia/Seoul'))
       AND (${opts.streamer ?? null}::text IS NULL OR EXISTS (
             SELECT 1 FROM fco_match_participant mine JOIN streamer ms2 ON ms2.id = mine.streamer_id
              WHERE mine.match_id = m.match_id AND ms2.slug = ${opts.streamer ?? null}))
     GROUP BY d.provider_match_id, m.match_id, e.name, e.kind, ctx.judgment, ctx.note, ctx.created_by
    HAVING count(*) = 2
     ORDER BY m.game_creation DESC
  `;
  const mapped = rows.map((r) => ({
    provider_match_id: r.provider_match_id,
    match_id: r.match_id,
    played_at: r.played_at,
    mode_key: r.mode_key,
    players: r.players,
    status: (r.event_name ? "event" : (r.judgment as FcoContextJudgment | null) ?? "uninvestigated") as FcoContextStatus,
    event_name: r.event_name,
    event_kind: r.event_kind,
    judgment_note: r.judgment_note,
    judgment_by: r.judgment_by,
    confirmed: r.confirmed,
    evidence_count: r.evidence_count,
  }));
  return opts.status ? mapped.filter((r) => r.status === opts.status) : mapped;
}

export interface FcoContextDetail {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  status: FcoContextStatus;
  /** 대회·분류 판단을 확인했나 (match.context_review_completed_at). */
  confirmed: boolean;
  event: { slug: string | null; name: string; kind: string; source_url: string | null } | null;
  participants: { slug: string | null; nickname: string; outcome: string; score: number | null }[];
  history: { judgment: string; note: string; created_by: string; created_at: string }[];
  evidences: {
    evidence_key: string; kind: string; vod_title_no: number | null; channel_id: string | null;
    at_sec: number | null; end_sec: number | null; url: string | null; frame_path: string | null;
    role: FcoEvidenceRole | null;
    observed: string; why: string | null; created_by: string;
  }[];
}

export async function getFcoContextDetail(providerMatchId: string): Promise<FcoContextDetail | null> {
  const sql = db();
  const games = await sql<{
    match_id: string; played_at: string; mode_key: string | null; confirmed: boolean;
    slug: string | null; name: string | null; kind: string | null; source_url: string | null;
  }[]>`
    SELECT m.match_id, m.game_creation AS played_at, m.mode_key,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           e.slug, e.name, e.kind, e.source_url
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
     WHERE d.provider_match_id = ${providerMatchId} AND m.game_code = 'fconline'
  `;
  const game = games[0];
  if (!game) return null;
  const participants = await sql<{ slug: string | null; nickname: string; outcome: string; score: number | null }[]>`
    SELECT s.slug, p.nickname, p.outcome, coalesce(p.score_display, p.goals) AS score
      FROM fco_match_participant p
      LEFT JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
     WHERE p.match_id = ${game.match_id} ORDER BY p.side_no
  `;
  const history = await sql<{ judgment: string; note: string; created_by: string; created_at: string }[]>`
    SELECT judgment, note, created_by, created_at FROM fco_match_context
     WHERE match_id = ${game.match_id} ORDER BY created_at DESC
  `;
  const evidences = await sql<FcoContextDetail["evidences"]>`
    SELECT evidence_key, kind, vod_title_no::int AS vod_title_no, channel_id, at_sec, end_sec, url,
           frame_path, role, observed, why, created_by
      FROM fco_context_evidence WHERE match_id = ${game.match_id} ORDER BY created_at
  `;
  return {
    provider_match_id: providerMatchId,
    match_id: game.match_id,
    played_at: game.played_at,
    mode_key: game.mode_key,
    status: game.name ? "event" : ((history[0]?.judgment as FcoContextJudgment | undefined) ?? "uninvestigated"),
    confirmed: game.confirmed,
    event: game.name ? { slug: game.slug, name: game.name, kind: game.kind!, source_url: game.source_url } : null,
    participants,
    history,
    evidences,
  };
}

/**
 * 검수 승인 — 조사(auto)의 현재 판단을 사람이 확인했다는 도장.
 *
 * 하는 일 두 가지뿐이다:
 *   1. 최신 판단이 auto 면 같은 내용을 admin 으로 다시 쌓는다 → 이후 자동 반영이 못 덮는다.
 *   2. match.reviewed_at 을 찍는다 (이미 있으면 유지) → 큐에서 「확인됨」이 된다.
 * 승인할 것이 없으면(미조사) 거부한다 — 도장은 조사를 대신하지 못한다.
 */
export async function approveFcoContext(
  providerMatchId: string, expectedVersion?: number,
): Promise<FcoContextOutcome> {
  const out: FcoContextOutcome = { provider_match_id: providerMatchId, actions: [], skipped: [] };
  const sql = db();
  await sql.begin(async (tx) => {
    const games = await tx<{ match_id: string; reviewed_at: string | null; review_completed_at: string | null; event_id: string | null; series_event_id: string | null }[]>`
      SELECT m.match_id, m.reviewed_at, m.review_completed_at, m.event_id, ms.event_id AS series_event_id
        FROM match m
        LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE (d.provider_match_id = ${providerMatchId} OR m.match_id = ${providerMatchId}) AND m.game_code = 'fconline'
       FOR UPDATE OF m
    `;
    const game = games[0];
    if (!game) throw new Error(`수집되지 않은 경기입니다: ${providerMatchId}`);
    await assertFcoContextVersion(tx, game.match_id, expectedVersion);
    const latest = await tx<{ judgment: string; note: string; created_by: string }[]>`
      SELECT judgment, note, created_by FROM fco_match_context
       WHERE match_id = ${game.match_id} ORDER BY created_at DESC LIMIT 1
    `;
    const hasEvent = Boolean(game.series_event_id ?? game.event_id);
    if (!latest[0] && !hasEvent) {
      throw new Error("승인할 판단이 없다 — 미조사 경기다. 먼저 조사(fco-match-context)가 제안을 남겨야 한다");
    }
    if (latest[0] && !hasEvent) {
      if (latest[0].created_by === "admin") {
        out.skipped.push("판단 — 이미 admin 판단이다");
      } else {
        await tx`
          INSERT INTO fco_match_context (match_id, judgment, note, created_by)
          VALUES (${game.match_id}, ${latest[0].judgment}, ${latest[0].note}, 'admin')
        `;
        out.actions.push(`판단 승인 ${latest[0].judgment} — 자동 반영이 못 덮는다`);
      }
    }
    if (await stampFcoContextReview(tx, game.match_id)) out.actions.push("대회·분류 판단 확정");
    else out.skipped.push("확인 도장 — 이미 찍혀 있다");
  });
  return out;
}

/**
 * 확인 도장 — 두 칸을 같이 찍는다. LoL 과 뜻이 같다(0043).
 *   reviewed_at          자동 조사가 덮지 못하게 하는 보호
 *   review_completed_at  사람이 확인해 끝냈다는 완료 (큐의 「확인됨」·화면 경기의 「완료」가 읽는 것)
 * FC 는 한동안 reviewed_at 하나에 두 뜻을 담았다. 한 곳에서만 찍어 다시 갈라지지 않게 한다.
 * @returns 완료가 새로 찍혔으면 true (이미 완료였으면 false)
 */
export async function stampFcoReview(tx: Tx, matchId: string): Promise<boolean> {
  const rows = await tx<{ match_id: string }[]>`
    UPDATE match
       SET reviewed_at = COALESCE(reviewed_at, now()),
           review_completed_at = COALESCE(review_completed_at, now())
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND review_completed_at IS NULL
    RETURNING match_id`;
  if (rows.length) return true;
  await tx`UPDATE match SET reviewed_at = COALESCE(reviewed_at, now()) WHERE match_id = ${matchId} AND game_code = 'fconline'`;
  return false;
}

// ── 검수 작업대 — 행사 단위로 묶어서 본다 ────────────────────────────

/** Context confirmation is independent from match-value review and automatic value protection. */
export async function stampFcoContextReview(tx: Tx, matchId: string): Promise<boolean> {
  const rows = await tx<{ match_id: string }[]>`
    UPDATE match SET context_review_completed_at = now(), context_review_version = context_review_version + 1
     WHERE match_id = ${matchId} AND game_code = 'fconline' AND context_review_completed_at IS NULL RETURNING match_id`;
  return rows.length > 0;
}

export interface FcoWorkspaceMatch {
  provider_match_id: string;
  match_id: string;
  played_at: string;
  mode_key: string | null;
  confirmed: boolean;
  context_version: number;
  value_completed: boolean;
  /** 다전제에 묶였으면 그 시리즈. 승패는 세트에서 파생한다(series.ts). */
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  participants: { ouid: string; name: string; slug: string | null; outcome: string; score: number | null }[];
  /**
   * 이 단위(행사)에서의 포함/제외. 결정 행이 없고 연결만 있으면 'include'(조사가 붙였다),
   * 결정도 연결도 없으면 null(행사 기간 안에 있어 후보로 올라온 미정 경기).
   */
  decision: "include" | "exclude" | null;
  /** 최신 결정의 주체. 'admin' 이면 사람이 정했다. 결정 행이 없으면 null. */
  decision_by: string | null;
  bracket_no: number | null;
  bracket_label: string | null;
  decision_note: string | null;
}

export interface FcoWorkspaceEvidence {
  evidence_key: string;
  provider_match_id: string;
  kind: string;
  vod_title_no: number | null;
  channel_id: string | null;
  at_sec: number | null;
  end_sec: number | null;
  url: string | null;
  frame_path: string | null;
  role: FcoEvidenceRole | null;
  observed: string;
  why: string | null;
  created_by: string;
}

/**
 * 검수 단위 — 행사로 결론난 경기는 **행사 하나가 한 단위**다. 검수자는 대회의
 * 시작부터 끝까지 프레임을 넘기며 전체 맥락을 보고 한 번에 승인한다.
 * 행사에 안 붙은 경기는 경기 하나가 한 단위다.
 */
export interface FcoReviewUnit {
  /** 'event:<uuid>' | 'match:<providerMatchId>' */
  id: string;
  kind: "event" | "match";
  title: string;
  status: FcoContextStatus;
  /** 단위 전체가 확인됨 — 행사면 소속 경기 전부. */
  confirmed: boolean;
  /** 제안이 있는데 확인 도장이 없다 — 검수가 할 일. */
  pending: boolean;
  event: {
    id: string; slug: string | null; name: string; kind: string; organizer: string | null; source_url: string | null;
    starts_at: string | null; ends_at: string | null; admin_version: number;
  } | null;
  judgment: { judgment: string; note: string; created_by: string; created_at: string } | null;
  /** 행사면 포함(브래킷 번호순) → 미정 → 제외 순. 제외한 경기도 사라지지 않고 남는다. */
  matches: FcoWorkspaceMatch[];
  /** 단위의 모든 근거 — VOD·초 순. 프레임을 순서로 넘기면 시간 흐름이 된다. */
  evidences: FcoWorkspaceEvidence[];
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

export async function getFcoReviewWorkspace(
  /** 하나만 열 때 좁힌다 — 작업대는 단위 하나만 읽는다(2층 구조). */
  opts: { eventId?: string; providerMatchId?: string; onlyEvents?: boolean } = {},
): Promise<FcoReviewUnit[]> {
  const sql = db();
  if (opts.eventId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.eventId)) return [];
  let targetEvent = opts.eventId;
  let targetMatch: string | undefined;
  if (opts.providerMatchId) {
    const [r] = await sql<{ match_id: string; event_id: string | null }[]>`SELECT m.match_id,
      COALESCE(ms.event_id, m.event_id, (SELECT d.event_id FROM fco_event_match_decision d WHERE d.match_id = m.match_id ORDER BY d.created_at DESC LIMIT 1)) AS event_id
      FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      WHERE m.game_code = 'fconline' AND (d.provider_match_id = ${opts.providerMatchId} OR m.match_id = ${opts.providerMatchId})`;
    if (!r) return [];
    targetMatch = r.match_id; targetEvent = r.event_id ?? undefined;
  }
  // ── 대회 후보. 연결된 경기만이 아니다 — 제외한 경기도(결정 행), 행사 기간 안인데 아직 아무도
  //    안 정한 경기도(그 행사 참가자가 뛴 판) 후보로 남아야 「안 붙인 건지 뺀 건지」가 보인다.
  const latestDecisions = await sql<{
    event_id: string; match_id: string; decision: "include" | "exclude"; created_by: string;
    bracket_no: number | null; bracket_label: string | null; note: string | null; created_at: Date;
  }[]>`
    SELECT DISTINCT ON (event_id, match_id) event_id, match_id, decision, created_by,
           bracket_no, bracket_label, note, created_at
      FROM fco_event_match_decision
     WHERE ${targetEvent ? sql`event_id = ${targetEvent}::uuid` : sql`true`}
     ORDER BY event_id, match_id, created_at DESC
  `;
  const windowed = await sql<{ event_id: string; match_id: string }[]>`
    WITH linked AS (
      SELECT COALESCE(ms.event_id, m.event_id) AS event_id, m.match_id
        FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE m.game_code = 'fconline' AND COALESCE(ms.event_id, m.event_id) IS NOT NULL
    ), roster AS (
      SELECT DISTINCT l.event_id, p.streamer_id FROM linked l
        JOIN fco_match_participant p ON p.match_id = l.match_id
       WHERE p.streamer_id IS NOT NULL
    )
    SELECT e.id AS event_id, m.match_id
      FROM event e
      JOIN match m ON m.game_code = 'fconline' AND m.game_creation BETWEEN e.starts_at AND e.ends_at
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
     WHERE e.game_code = 'fconline' AND ${targetEvent ? sql`e.id = ${targetEvent}::uuid` : sql`true`} AND e.starts_at IS NOT NULL AND e.ends_at IS NOT NULL
       AND COALESCE(ms.event_id, m.event_id) IS NULL
       AND EXISTS (SELECT 1 FROM fco_match_participant p
                     JOIN roster r ON r.streamer_id = p.streamer_id AND r.event_id = e.id
                    WHERE p.match_id = m.match_id)
  `;
  if (!targetEvent && targetMatch) targetEvent = windowed.find(w => w.match_id === targetMatch)?.event_id;
  const candidateIds = [...new Set([...latestDecisions.map((d) => d.match_id), ...windowed.map((w) => w.match_id)])];

  // 행사에 붙은 경기는 매핑과 무관하게 전부 보여 준다 — 대회 흐름에 구멍을 내지 않는다.
  // 행사가 없는 경기는 공개 스트리머 간 1:1 만 검수 대상이다(큐와 같은 기준).
  const matches = await sql<{
    provider_match_id: string; match_id: string; played_at: Date; mode_key: string | null;
    confirmed: boolean; context_version: number; value_completed: boolean; event_id: string | null;
    series_id: string | null; series_game_no: number | null; best_of: number | null;
    judgment: string | null; note: string | null; judgment_by: string | null; judged_at: Date | null;
    participants: FcoWorkspaceMatch["participants"];
    public_n: number;
  }[]>`
    SELECT COALESCE(d.provider_match_id, m.match_id) AS provider_match_id, m.match_id, m.game_creation AS played_at, m.mode_key,
           (m.context_review_completed_at IS NOT NULL) AS confirmed,
           m.context_review_version AS context_version, (m.review_completed_at IS NOT NULL) AS value_completed,
           COALESCE(ms.event_id, m.event_id) AS event_id,
           m.series_id, m.series_game_no, ms.best_of,
           ctx.judgment, ctx.note, ctx.created_by AS judgment_by, ctx.created_at AS judged_at,
           parts.list AS participants, parts.public_n
      FROM match m
      LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN LATERAL (
        SELECT judgment, note, created_by, created_at FROM fco_match_context c
         WHERE c.match_id = m.match_id ORDER BY created_at DESC LIMIT 1
      ) ctx ON true
      CROSS JOIN LATERAL (
        SELECT json_agg(json_build_object(
                 -- 화면에 쓰는 이름은 display_name 이다. slug 는 링크·필터용으로 같이 준다.
                 'ouid', p.ouid,
                 'name', coalesce(s.display_name, p.nickname), 'slug', s.slug,
                 'outcome', p.outcome, 'score', coalesce(p.score_display, p.goals))
                 ORDER BY p.side_no) AS list,
               count(s.id)::int AS public_n
          FROM fco_match_participant p
          LEFT JOIN streamer s ON s.id = p.streamer_id AND s.visibility = 'public'
         WHERE p.match_id = m.match_id
      ) parts
     WHERE m.game_code = 'fconline'
       AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
       AND ${targetEvent ? sql`(COALESCE(ms.event_id, m.event_id) = ${targetEvent}::uuid OR m.match_id = ANY(${candidateIds}))` : targetMatch ? sql`m.match_id = ${targetMatch}` : opts.onlyEvents ? sql`(COALESCE(ms.event_id, m.event_id) IS NOT NULL OR m.match_id = ANY(${candidateIds}))` : sql`true`}
       AND (COALESCE(ms.event_id, m.event_id) IS NOT NULL OR parts.public_n = 2
            OR m.match_id = ANY(${candidateIds}))
     ORDER BY m.game_creation
  `;

  // 경기 → 단위 행사. 연결이 우선이고, 없으면 가장 최근 결정의 행사, 그것도 없으면 기간이 겹친 행사.
  const decisionsByMatch = new Map<string, (typeof latestDecisions)[number][]>();
  for (const d of latestDecisions) {
    if (!decisionsByMatch.has(d.match_id)) decisionsByMatch.set(d.match_id, []);
    decisionsByMatch.get(d.match_id)!.push(d);
  }
  const windowByMatch = new Map(windowed.map((w) => [w.match_id, w.event_id]));
  const unitEventOf = (m: (typeof matches)[number]): string | null => {
    if (targetEvent && (m.event_id === targetEvent || decisionsByMatch.get(m.match_id)?.some(d => d.event_id === targetEvent) || windowed.some(w => w.match_id === m.match_id && w.event_id === targetEvent))) return targetEvent;
    if (m.event_id) return m.event_id;
    const ds = decisionsByMatch.get(m.match_id);
    if (ds?.length) return [...ds].sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0].event_id;
    return windowByMatch.get(m.match_id) ?? null;
  };

  const matchIds = matches.map((m) => m.match_id);
  const eventIds = [...new Set(matches.map(unitEventOf).filter((v): v is string => v != null))];
  const events = eventIds.length ? await sql<{
    id: string; slug: string | null; name: string; kind: string; organizer: string | null; source_url: string | null;
    starts_at: Date | null; ends_at: Date | null; admin_version: number;
  }[]>`SELECT id, slug, name, kind, organizer, source_url, starts_at, ends_at, admin_version
         FROM event WHERE id = ANY(${eventIds}::uuid[])` : [];
  const evidences = matchIds.length ? await sql<(FcoWorkspaceEvidence & { match_id: string })[]>`
    SELECT fe.evidence_key, COALESCE(d.provider_match_id, fe.match_id) AS provider_match_id, fe.match_id, fe.kind,
           fe.vod_title_no::int AS vod_title_no, fe.channel_id, fe.at_sec, fe.end_sec,
           fe.url, fe.frame_path, fe.role, fe.observed, fe.why, fe.created_by
      FROM fco_context_evidence fe
      LEFT JOIN fco_match_detail d ON d.match_id = fe.match_id
     WHERE fe.match_id = ANY(${matchIds})
     ORDER BY fe.vod_title_no NULLS LAST, fe.at_sec NULLS LAST, fe.evidence_key
  ` : [];
  const evidenceByMatch = new Map<string, FcoWorkspaceEvidence[]>();
  for (const evidence of evidences) {
    if (!evidenceByMatch.has(evidence.match_id)) evidenceByMatch.set(evidence.match_id, []);
    evidenceByMatch.get(evidence.match_id)!.push(evidence);
  }

  const toMatch = (m: (typeof matches)[number], eventId: string | null): FcoWorkspaceMatch => {
    const d = eventId ? decisionsByMatch.get(m.match_id)?.find((x) => x.event_id === eventId) : undefined;
    const linkedHere = eventId != null && m.event_id === eventId;
    return {
      provider_match_id: m.provider_match_id, match_id: m.match_id, played_at: iso(m.played_at),
      mode_key: m.mode_key, confirmed: m.confirmed, context_version: m.context_version, value_completed: m.value_completed,
      series_id: m.series_id, series_game_no: m.series_game_no, best_of: m.best_of,
      participants: m.participants ?? [],
      decision: d ? d.decision : linkedHere ? "include" : null,
      decision_by: d?.created_by ?? null,
      bracket_no: d?.bracket_no ?? null,
      bracket_label: d?.bracket_label ?? null,
      decision_note: d?.note ?? null,
    };
  };
  // 포함(브래킷 번호순 → 시각) → 미정 → 제외.
  const rank = (x: FcoWorkspaceMatch) => (x.decision === "include" ? 0 : x.decision === null ? 1 : 2);
  const order = (a: FcoWorkspaceMatch, b: FcoWorkspaceMatch) =>
    rank(a) - rank(b)
    || (a.bracket_no ?? 1e9) - (b.bracket_no ?? 1e9)
    || a.played_at.localeCompare(b.played_at);

  const units: FcoReviewUnit[] = [];
  for (const event of events) {
    const mine = matches.filter((m) => unitEventOf(m) === event.id).map((m) => toMatch(m, event.id)).sort(order);
    const included = mine.filter((m) => m.decision === "include");
    const unitEvidences = mine.flatMap((m) => evidenceByMatch.get(m.match_id) ?? []);
    const confirmed = mine.length > 0 && mine.every((m) => m.decision != null && m.confirmed);
    units.push({
      id: `event:${event.id}`, kind: "event",
      title: event.name, status: "event",
      confirmed,
      pending: !confirmed,
      event: { ...event, starts_at: event.starts_at ? iso(event.starts_at) : null, ends_at: event.ends_at ? iso(event.ends_at) : null },
      judgment: null,
      matches: mine,
      evidences: unitEvidences,
    });
  }
  for (const m of matches.filter((m) => !unitEventOf(m) && m.public_n === 2)) {
    const status = ((m.judgment as FcoContextJudgment | null) ?? "uninvestigated") as FcoContextStatus;
    units.push({
      id: `match:${m.provider_match_id}`, kind: "match",
      title: (m.participants ?? []).map((p) => p.name).join(" vs "),
      status,
      confirmed: m.confirmed,
      pending: status !== "uninvestigated" && !m.confirmed,
      event: null,
      judgment: m.judgment ? {
        judgment: m.judgment, note: m.note ?? "", created_by: m.judgment_by ?? "auto", created_at: iso(m.judged_at),
      } : null,
      matches: [toMatch(m, null)],
      evidences: evidenceByMatch.get(m.match_id) ?? [],
    });
  }
  // 최근 것이 위. 행사는 마지막 경기 기준.
  const lastPlayed = (u: FcoReviewUnit) => u.matches.map((m) => m.played_at).sort().at(-1) ?? "";
  const sorted = units.sort((a, b) => lastPlayed(b).localeCompare(lastPlayed(a)));
  // 좁히기 — 경기로 열면 그 경기가 속한 단위(행사면 행사 전체)를 준다.
  if (opts.eventId) return sorted.filter((u) => u.id === `event:${opts.eventId}`);
  if (opts.providerMatchId) return sorted.filter((u) => u.matches.some((m) => m.provider_match_id === opts.providerMatchId || m.match_id === opts.providerMatchId));
  return sorted;
}

// ── 대회 후보의 포함/제외 결정 (0034) ─────────────────────────────────

export interface FcoEventDecisionInput {
  eventId: string;
  providerMatchId: string;
  expectedVersion?: number;
  decision: "include" | "exclude";
  bracketNo?: number | null;
  bracketLabel?: string | null;
  /** 제외에는 필수 — 왜 뺐는지가 남아야 되돌릴 수 있다. */
  note?: string | null;
}

/**
 * 경기 하나를 대회에 넣거나 뺀다. 결정은 이력으로 쌓이고, match.event_id 를 같은 트랜잭션에서 맞춘다.
 * 사람(admin)이 정한 것은 자동 경로가 못 덮는다(⏭). 사람이 정하면 그 경기에 확인 도장도 찍힌다.
 */
export async function decideFcoEventMatch(
  input: FcoEventDecisionInput,
  opts: { createdBy?: "auto" | "admin" } = {},
): Promise<FcoContextOutcome> {
  const createdBy = opts.createdBy ?? "auto";
  const out: FcoContextOutcome = { provider_match_id: input.providerMatchId, actions: [], skipped: [] };
  const note = input.note?.trim() || null;
  const label = input.bracketLabel?.trim() || null;
  if (input.decision === "exclude" && !note) throw new Error("제외에는 이유가 필요하다 — 왜 대회 경기가 아닌지 적는다");
  if (input.bracketNo != null && (!Number.isInteger(input.bracketNo) || input.bracketNo < 1)) {
    throw new Error("브래킷 번호는 1 이상 정수다");
  }
  const sql = db();
  await sql.begin(async (tx) => {
    const [game] = await tx<{ match_id: string; event_id: string | null; series_id: string | null; series_event_id: string | null }[]>`
      SELECT m.match_id, m.event_id, m.series_id, ms.event_id AS series_event_id
        FROM match m
        LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE (d.provider_match_id = ${input.providerMatchId} OR m.match_id = ${input.providerMatchId}) AND m.game_code = 'fconline'
       FOR UPDATE OF m
    `;
    if (!game) throw new Error(`수집되지 않은 경기입니다: ${input.providerMatchId}`);
    await assertFcoContextVersion(tx, game.match_id, input.expectedVersion);
    const [ev] = await tx<{ game_code: string }[]>`SELECT game_code FROM event WHERE id = ${input.eventId}::uuid`;
    if (!ev) throw new Error("행사를 찾을 수 없다");
    if (ev.game_code !== "fconline") throw new Error("FC 행사가 아니다");

    const [latest] = await tx<{ decision: string; created_by: string; bracket_no: number | null; bracket_label: string | null; note: string | null }[]>`
      SELECT decision, created_by, bracket_no, bracket_label, note FROM fco_event_match_decision
       WHERE event_id = ${input.eventId}::uuid AND match_id = ${game.match_id}
       ORDER BY created_at DESC LIMIT 1
    `;
    if (latest && latest.created_by === "admin" && createdBy === "auto") {
      out.skipped.push("결정 — 사람이 정한 경기라 자동 반영이 덮지 않는다");
      return;
    }
    const same = latest && latest.decision === input.decision
      && (latest.bracket_no ?? null) === (input.bracketNo ?? null)
      && (latest.bracket_label ?? null) === label && (latest.note ?? null) === note;
    if (same && (latest.created_by === createdBy || latest.created_by === "admin")) {
      out.skipped.push("결정 — 이미 같은 내용 (멱등)");
    } else {
      await tx`
        INSERT INTO fco_event_match_decision (event_id, match_id, decision, bracket_no, bracket_label, note, created_by)
        VALUES (${input.eventId}::uuid, ${game.match_id}, ${input.decision}, ${input.bracketNo ?? null},
                ${label}, ${note}, ${createdBy})
      `;
      out.actions.push(`${input.decision === "include" ? "포함" : "제외"} 결정${label ? ` · ${label}` : ""} (${createdBy})`);
    }

    // 공개 값(match.event_id)을 결정에 맞춘다. 다전제는 행사의 주인이 시리즈다(0027).
    const effective = game.series_event_id ?? game.event_id;
    if (input.decision === "include") {
      if (game.series_id) {
        if (game.series_event_id && game.series_event_id !== input.eventId) {
          throw new Error("이 경기의 다전제가 다른 행사에 붙어 있다 — 시리즈 단위로 옮겨라");
        }
        if (!game.series_event_id) {
          const excluded = await humanExcludedInSeries(tx, game.series_id, input.eventId);
          if (excluded && excluded !== game.match_id) {
            throw new Error(`같은 시리즈의 ${excluded} 를 사람이 이 행사에서 제외했다 — 시리즈에 행사를 붙이면 되살아난다. 먼저 그 세트를 정리하라`);
          }
          await tx`UPDATE match_series SET event_id = ${input.eventId}::uuid, updated_at = now()
                    WHERE id = ${game.series_id} AND game_code = 'fconline'`;
          out.actions.push("다전제를 행사에 연결");
        }
      } else if (effective !== input.eventId) {
        if (effective && createdBy !== "admin") throw new Error("경기가 이미 다른 행사에 연결돼 있다 — 옮기는 것은 사람이 한다");
        if (effective) {
          await tx`INSERT INTO fco_event_match_decision (event_id, match_id, decision, note, created_by)
                   VALUES (${effective}::uuid, ${game.match_id}, 'exclude', '다른 행사로 옮김', ${createdBy})`;
        }
        await tx`UPDATE match SET event_id = ${input.eventId}::uuid WHERE match_id = ${game.match_id}`;
        out.actions.push(effective ? "다른 행사에서 옮겨 연결" : "행사 연결");
      }
    } else if (effective === input.eventId) {
      if (game.series_id) throw new Error("다전제의 한 세트만 뺄 수 없다 — 시리즈 단위로 정한다");
      await tx`UPDATE match SET event_id = NULL WHERE match_id = ${game.match_id}`;
      out.actions.push("행사 연결 해제 — 공개 화면의 대회 경기에서 빠진다");
    }
    // 포함·제외 판단만 확정한다. 경기값 검수 상태는 변경하지 않는다.
    if (createdBy === "admin") await stampFcoContextReview(tx, game.match_id);
  });
  return out;
}

/** 행사 정보 수정 — 검수 화면 [대회] 탭. 사람이 명시적으로 고치는 경로다. */
export async function updateFcoEvent(eventId: string, patch: {
  name?: string; kind?: string; organizer?: string | null; source_url?: string | null; expectedVersion?: number;
}): Promise<void> {
  if (patch.name != null && !patch.name.trim()) throw new Error("행사 이름은 비울 수 없다");
  if (patch.kind != null && !["ck", "scrim", "tournament", "showmatch", "other"].includes(patch.kind)) {
    throw new Error("행사 종류는 ck/scrim/tournament/showmatch/other 중 하나다");
  }
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    UPDATE event SET
      name = COALESCE(${patch.name?.trim() ?? null}, name),
      kind = COALESCE(${patch.kind ?? null}, kind),
      organizer = ${patch.organizer === undefined ? sql`organizer` : (patch.organizer?.trim() || null)},
      source_url = ${patch.source_url === undefined ? sql`source_url` : (patch.source_url?.trim() || null)}
     WHERE id = ${eventId}::uuid AND game_code = 'fconline'
       AND ${patch.expectedVersion === undefined ? sql`true` : sql`admin_version = ${patch.expectedVersion}`}
    RETURNING id
  `;
  if (!rows.length) throw new Error("행사 정보가 변경되었거나 삭제되었습니다. 새로고침 후 다시 확인해 주세요.");
}

/**
 * 승인 해제(보류) — 확인 도장만 뗀다.
 * ⚠ 판단 이력(fco_match_context)은 append-only 라 지우지 않는다. 승인 때 admin 으로 승격한
 *   판단은 그대로 남는다 — 「사람이 한 번 봤다」는 사실이 사라지면 안 되기 때문이다.
 *   판단 자체를 되돌리려면 새 판단을 기록한다(그게 이력이다).
 */
export async function holdFcoContext(providerMatchId: string, expectedVersion?: number): Promise<FcoContextOutcome> {
  return db().begin(async tx => {
    const [m] = await tx<{ match_id: string }[]>`SELECT m.match_id FROM match m LEFT JOIN fco_match_detail d ON d.match_id = m.match_id
      WHERE m.game_code = 'fconline' AND (m.match_id = ${providerMatchId} OR d.provider_match_id = ${providerMatchId}) FOR UPDATE OF m`;
    if (!m) throw new Error("경기를 찾지 못했습니다.");
    await assertFcoContextVersion(tx, m.match_id, expectedVersion);
    const rows = await tx`UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
      WHERE match_id = ${m.match_id} AND context_review_completed_at IS NOT NULL RETURNING match_id`;
    return { provider_match_id: providerMatchId, actions: rows.length ? ["대회·분류 확정 해제"] : [], skipped: rows.length ? [] : ["이미 대기 상태입니다."] };
  });
}

export type FcoContextSnapshot = Record<string, number>;
async function eventContextMatches(tx: Tx, eventId: string, expected?: FcoContextSnapshot) {
  const rows = await tx<{ match_id: string; included: boolean; context_review_version: number }[]>`
    SELECT m.match_id, COALESCE(ms.event_id, m.event_id) = ${eventId}::uuid AS included, m.context_review_version
    FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
    WHERE m.game_code = 'fconline'
      AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)
      AND (COALESCE(ms.event_id, m.event_id) = ${eventId}::uuid
      OR EXISTS (SELECT 1 FROM fco_event_match_decision d WHERE d.event_id = ${eventId}::uuid AND d.match_id = m.match_id))
    ORDER BY m.match_id FOR UPDATE OF m`;
  if (expected) {
    if (rows.some(r => expected[r.match_id] !== r.context_review_version)
        || Object.keys(expected).some(id => !rows.some(r => r.match_id === id))) {
      throw new Error("대회 후보나 판단이 변경되었습니다. 새로고침 후 다시 확인해 주세요.");
    }
  }
  return rows;
}

/** Holds only the context confirmation, including explicit exclusions. */
export async function holdFcoEvent(eventId: string, expected?: FcoContextSnapshot): Promise<{ cleared: number }> {
  return db().begin(async tx => {
    const ids = await eventContextMatches(tx, eventId, expected);
    const rows = await tx`UPDATE match SET context_review_completed_at = NULL, context_review_version = context_review_version + 1
      WHERE match_id = ANY(${ids.map(r => r.match_id)}) AND context_review_completed_at IS NOT NULL RETURNING match_id`;
    return { cleared: rows.length };
  });
}

export interface FcoEventOption {
  id: string;
  slug: string | null;
  name: string;
  kind: string;
  organizer: string | null;
  source_url: string | null;
  games: number;
}

/** 검수 화면의 행사 선택지 — 공개 여부와 무관하게 FC 행사를 전부 준다. */
export async function listFcoEventOptions(): Promise<FcoEventOption[]> {
  const sql = db();
  return sql<FcoEventOption[]>`
    SELECT e.id, e.slug, e.name, e.kind, e.organizer, e.source_url,
           (SELECT count(*)::int FROM match m
              LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
             WHERE COALESCE(ms.event_id, m.event_id) = e.id AND m.game_code = 'fconline') AS games
      FROM event e
     WHERE e.game_code = 'fconline'
     ORDER BY e.starts_at DESC NULLS LAST, e.name
  `;
}

/**
 * 행사 단위 승인 — 포함·제외 결정을 확정한다. 경기값 완료와 보호 시각은 유지한다.
 * 행사 연결 자체가 결론이므로 판단 행은 만들지 않는다.
 */
export async function approveFcoEvent(eventId: string, expected?: FcoContextSnapshot): Promise<{
  stamped: number; already: number; included: number; excluded: number; promoted: number;
}> {
  const sql = db();
  return sql.begin(async (tx) => {
    const decidedMatches = await eventContextMatches(tx, eventId, expected);
    const ids = decidedMatches.filter(m => m.included);
    if (!decidedMatches.length) throw new Error("확정할 대회 판단이 없습니다.");
    // ★ 조사 제안을 사람 결정으로 굳힌다 — 사람이 안 건드린 경기는 「조사대로 맞다」는 뜻이다.
    //   굳히지 않으면 다음 자동 조사가 그 경기를 뒤집을 수 있다.
    const latest = await tx<{ match_id: string; decision: string; created_by: string; bracket_no: number | null; bracket_label: string | null; note: string | null }[]>`
      SELECT DISTINCT ON (match_id) match_id, decision, created_by, bracket_no, bracket_label, note
        FROM fco_event_match_decision WHERE event_id = ${eventId}::uuid
         AND match_id = ANY(${decidedMatches.map(m => m.match_id)})
       ORDER BY match_id, created_at DESC
    `;
    let promoted = 0;
    for (const d of latest.filter((x) => x.created_by !== "admin")) {
      await tx`
        INSERT INTO fco_event_match_decision (event_id, match_id, decision, bracket_no, bracket_label, note, created_by)
        VALUES (${eventId}::uuid, ${d.match_id}, ${d.decision}, ${d.bracket_no}, ${d.bracket_label}, ${d.note}, 'admin')
      `;
      promoted++;
    }
    // 연결만 있고 결정 행이 없는 경기(옛 경로로 붙은 것)도 포함으로 굳힌다.
    const decided = new Set(latest.map((x) => x.match_id));
    for (const { match_id } of ids.filter((x) => !decided.has(x.match_id))) {
      await tx`INSERT INTO fco_event_match_decision (event_id, match_id, decision, created_by)
               VALUES (${eventId}::uuid, ${match_id}, 'include', 'admin')`;
      promoted++;
    }
    const stamped = await tx<{ match_id: string }[]>`
      UPDATE match SET context_review_completed_at = now(), context_review_version = context_review_version + 1
       WHERE match_id = ANY(${decidedMatches.map((r) => r.match_id)}) AND context_review_completed_at IS NULL
       RETURNING match_id
    `;
    return {
      stamped: stamped.length, already: decidedMatches.length - stamped.length, promoted,
      included: ids.length, excluded: latest.filter((x) => x.decision === "exclude").length,
    };
  });
}

/**
 * 계정을 새로 연결한 사람의 경기 중, **이미 있는 행사의 기간 안인데 행사에 안 붙은 것.**
 *
 * ★ 왜 있나 (2026-09-24): 뿌챔스 조사에서 서도일 계정을 나중에 연결했는데 대회 연결 목록을
 *   다시 만들지 않아 그의 대회 경기 2건이 통째로 빠졌다. 계정 연결과 행사 연결이 따로 놀면
 *   한쪽만 하고 끝나도 아무도 모른다. 판단은 하지 않는다 — 후보를 보여 줄 뿐이다(개막 전
 *   연습처럼 기간 안이어도 대회 경기가 아닌 판이 있다).
 */
export async function listUnlinkedInEventWindows(streamerSlug: string): Promise<{
  provider_match_id: string; played_at: string; players: string; event_slug: string; event_name: string;
}[]> {
  const sql = db();
  return sql`
    SELECT d.provider_match_id, m.game_creation AS played_at, e.slug AS event_slug, e.name AS event_name,
           (SELECT string_agg(coalesce(s2.display_name, p2.nickname), ' vs ' ORDER BY p2.side_no)
              FROM fco_match_participant p2 LEFT JOIN streamer s2 ON s2.id = p2.streamer_id
             WHERE p2.match_id = m.match_id) AS players
      FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      JOIN fco_match_participant me ON me.match_id = m.match_id
      JOIN streamer s ON s.id = me.streamer_id AND s.slug = ${streamerSlug}
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      JOIN event e ON e.game_code = 'fconline' AND e.starts_at IS NOT NULL AND e.ends_at IS NOT NULL
                  AND m.game_creation BETWEEN e.starts_at AND e.ends_at
     WHERE m.game_code = 'fconline' AND COALESCE(ms.event_id, m.event_id) IS NULL
       -- 이미 포함/제외를 정한 경기는 할 일이 아니다.
       AND NOT EXISTS (SELECT 1 FROM fco_event_match_decision x WHERE x.event_id = e.id AND x.match_id = m.match_id)
     ORDER BY m.game_creation
  `;
}

// ── 교차 단서 — LoL 조사가 실제로 연 화면에서 FC 가 보였을 때 ──────────

export interface FcoCrossClueInput {
  vod_title_no: number;
  channel_id: string;
  /** VOD 전체 초. */
  at_sec: number;
  /** 실제로 본 것. 추측이 아니라 화면 내용. */
  observed: string;
  title?: string;
  /** 그 단서가 가리키는 방송 시각(대략이라도). 수집 시각을 넣지 않는다 — VOD 목록의 시각에서 계산한다. */
  observed_at: string;
  url?: string | null;
}

export interface FcoCrossClueRow {
  vod_title_no: number;
  channel_id: string | null;
  at_sec: number | null;
  observed: string;
  title: string;
  observed_at: string;
  state: string;
}

/** LoL 조사가 남긴 FC 교차 단서. 기본은 미처리(state=new)만 — 조사 후보에 합류시키는 입구다. */
export async function listFcoCrossClues(opts: { all?: boolean; who?: string; vod?: string; q?: string } = {}): Promise<FcoCrossClueRow[]> {
  const sql = db();
  return sql<FcoCrossClueRow[]>`
    -- ::int — postgres.js 는 bigint 를 문자열로 돌려준다. title_no 는 int4 로 충분하다.
    SELECT (raw ->> 'vod_title_no')::int AS vod_title_no, channel_id,
           (raw ->> 'at_sec')::int AS at_sec, raw ->> 'observed' AS observed,
           title, observed_at, state
      FROM event_lead
     WHERE source = 'fc_screen'
       AND (${opts.all ?? false} OR state = 'new')
       AND ${opts.vod ? sql`raw ->> 'vod_title_no' = ${opts.vod}` : sql`true`}
       AND ${opts.q ? sql`concat_ws(' ', title, raw ->> 'observed') ILIKE ${`%${opts.q}%`}` : sql`true`}
       AND ${opts.who ? sql`EXISTS (SELECT 1 FROM streamer_channel sc JOIN streamer st ON st.id = sc.streamer_id WHERE st.slug = ${opts.who} AND sc.channel_id = event_lead.channel_id)` : sql`true`}
     ORDER BY observed_at DESC
  `;
}

/** 이미 있으면 조용히 두 번 쌓지 않는다. 반환값이 false 면 기존 단서가 있었던 것이다. */
export async function addFcoCrossClue(input: FcoCrossClueInput): Promise<boolean> {
  if (!input.observed?.trim()) throw new Error("observed(본 것) 없이 교차 단서를 남기지 않는다");
  if (!input.observed_at) throw new Error("observed_at(방송 시각)이 필요하다 — VOD 목록의 시각에서 계산해 넣는다");
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO event_lead (source, source_key, url, channel_id, title, observed_at, raw)
    VALUES ('fc_screen', ${`fc:${input.vod_title_no}:${input.at_sec}`},
            ${input.url ?? `https://vod.sooplive.com/player/${input.vod_title_no}`},
            ${input.channel_id},
            ${input.title ?? `FC 화면 단서 — VOD ${input.vod_title_no}`},
            ${input.observed_at},
            ${sql.json({ vod_title_no: input.vod_title_no, at_sec: input.at_sec, observed: input.observed })})
    ON CONFLICT (source, source_key) DO NOTHING
    RETURNING id
  `;
  return rows.length > 0;
}
