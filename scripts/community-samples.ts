/**
 * 커뮤니티 미리보기 샘플 — 공개 전에 화면을 채워 보려고 넣고, **가입을 열기 전에 지운다.**
 *
 *   node --env-file=apps/web/.env.local scripts/community-samples.ts            # 넣기(이미 있으면 멈춘다)
 *   node --env-file=apps/web/.env.local scripts/community-samples.ts --remove   # 지우기
 *
 * ★ 개발 서버의 DATABASE_URL 이 운영 DB 라서 샘플도 운영 DB 에 들어간다(2026-10-08 넣음).
 *   샘플 회원은 고정 id 이고 소셜 연결(member_identity)이 없다 — 아무도 그 회원으로 로그인할 수 없다.
 * ★ 쓰기는 core 의 회원 쓰기 함수를 그대로 거친다(닉네임 사칭 검사·분류·태그 검증·쓰기 한도).
 *   시각을 과거로 넘겨 며칠에 걸쳐 쓴 것처럼 만든다 — 한도는 그 시각 기준으로 세므로 시간 순서대로 쓴다.
 * ★ 지우기는 샘플 회원이 만든 것 전부 + 샘플 공지 + 그것들을 가리키는 신고·운영 기록·제재다.
 *   관리자 화면에서 샘플로 숨김·제재를 시험해 봤어도 흔적이 남지 않는다.
 */
import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { createComment, createPost, votePost } from "@soop-lol/core/lib/db/community";
import { createNotice } from "@soop-lol/core/lib/db/community-admin";
import { createSession, deleteSession, setNickname } from "@soop-lol/core/lib/db/member";
import type { CommunityGame, CommunityTopic } from "@soop-lol/core/lib/metrics/community";

const MEMBERS = {
  canyon: { id: "00000000-0000-4000-8000-000000000001", nickname: "협곡산책" },
  jungle: { id: "00000000-0000-4000-8000-000000000002", nickname: "정글차이" },
  mid: { id: "00000000-0000-4000-8000-000000000003", nickname: "미드한잔" },
  support: { id: "00000000-0000-4000-8000-000000000004", nickname: "서폿장인" },
  touch: { id: "00000000-0000-4000-8000-000000000005", nickname: "볼터치장인" },
  curl: { id: "00000000-0000-4000-8000-000000000006", nickname: "감아차기" },
} as const;
type Who = keyof typeof MEMBERS;
const SAMPLE_IDS = Object.values(MEMBERS).map((m) => m.id);

const at = (s: string) => new Date(`2026-${s.replace(" ", "T")}:00+09:00`);

/** 지우기는 작성자(NULL)·제목·시각이 모두 같은 공지만 샘플로 본다. */
const NOTICE = {
  at: at("10-05 20:00"),
  game_code: null,
  title: "커뮤니티 이용 안내",
  body: [
    "SOOP 스트리머들의 경기 이야기를 나누는 곳입니다.",
    "",
    "· 게임은 LOL·FC·기타 중에서 고르고, 이야기할 스트리머를 태그하면 프로필과 상대전적에서 바로 이어집니다.",
    "· 욕설·비방·사칭·개인정보 노출은 숨김이나 글쓰기 제한 대상입니다. 자세한 기준은 운영정책을 봐 주세요.",
    "· 문제가 있는 글은 '신고'를 눌러 주세요. 운영자가 확인합니다.",
  ].join("\n"),
};

interface SampleComment { key?: string; at: string; who: Who; body: string; parent?: string }
interface SamplePost {
  key: string; at: string; who: Who; game: CommunityGame | null; topic: Exclude<CommunityTopic, "notice">;
  title: string; body: string; tags?: string[];
  votes?: { at: string; who: Who }[];
  comments?: SampleComment[];
}

const POSTS: SamplePost[] = [
  {
    key: "hello", at: "10-05 21:14", who: "canyon", game: null, topic: "free",
    title: "커뮤니티 생겼네요",
    body: "상대전적 보다가 메뉴에 커뮤니티가 생긴 걸 봤어요.\n롤이랑 FC 이야기를 다 여기서 하면 되는 건가요?",
    votes: [{ at: "10-05 21:20", who: "jungle" }, { at: "10-05 22:02", who: "touch" }, { at: "10-06 08:15", who: "curl" }],
    comments: [
      { key: "chips", at: "10-05 21:30", who: "touch", body: "위에 게임 칩에서 LOL·FC 골라 보면 돼요. 기타는 게임이랑 상관없는 글만 모아 둔 거고요." },
      { at: "10-05 21:41", who: "canyon", parent: "chips", body: "아하 전체를 누르면 다 보이는 거군요. 감사합니다." },
      { at: "10-06 08:12", who: "curl", body: "FC 쪽도 같이 있어서 좋네요." },
    ],
  },
  {
    key: "lane", at: "10-05 22:40", who: "jungle", game: "lol", topic: "question",
    title: "상대전적에서 '맞라인'은 어떻게 세나요?",
    body: "같은 판에서 만난 기록이랑 맞라인 기록이 따로 나오던데, 맞라인은 같은 포지션으로 붙은 판만 세는 건가요?",
    votes: [{ at: "10-05 23:01", who: "canyon" }, { at: "10-06 00:10", who: "mid" }],
    comments: [
      { key: "lane-a", at: "10-05 23:05", who: "support", body: "포지션 기록이 서로 어긋나는 판은 빼고 센다고 들었어요. 그래서 같이 한 판 수보다 적게 나올 수 있어요." },
      { at: "10-05 23:20", who: "jungle", parent: "lane-a", body: "그래서 숫자가 달랐군요. 이해했습니다." },
    ],
  },
  {
    key: "versus-lol", at: "10-06 13:05", who: "mid", game: "lol", topic: "match",
    title: "바밤바 vs 성훈 맞대결 기록 보신 분?",
    body: "상대전적 화면에서 '맞대결 이야기' 눌러서 들어왔어요.\n두 분 내전에서 정말 많이 만났네요. 다음 내전 때도 여기서 같이 이야기해요.",
    tags: ["babamba", "seonghun"],
    votes: [{ at: "10-06 13:12", who: "canyon" }, { at: "10-06 13:50", who: "jungle" }, { at: "10-06 15:30", who: "support" }, { at: "10-06 20:05", who: "touch" }],
    comments: [
      { at: "10-06 13:40", who: "canyon", body: "다음 내전 일정 나오면 여기 남겨 주세요." },
      { at: "10-06 14:02", who: "jungle", body: "맞대결 이야기 버튼 생긴 거 좋네요 ㅋㅋ" },
    ],
  },
  {
    key: "club", at: "10-06 19:30", who: "touch", game: "fconline", topic: "free",
    title: "구단가치 그래프 보는 재미",
    body: "FC 프로필에 구단가치가 날짜별로 쌓이는 게 좋네요.\n스쿼드 바뀔 때 그래프가 같이 움직이는 것도 보이고요.",
    votes: [{ at: "10-06 21:00", who: "curl" }],
  },
  {
    key: "meljang", at: "10-06 23:52", who: "support", game: "lol", topic: "info",
    title: "멸망전 지난 시즌 결과 보는 곳",
    body: "대회 메뉴에 지난 멸망전 시즌별 결과가 정리돼 있어요.\n팀 구성까지 나와서 옛날 시즌 찾아볼 때 편합니다.",
    votes: [
      { at: "10-07 00:05", who: "canyon" }, { at: "10-07 00:20", who: "mid" }, { at: "10-07 09:40", who: "jungle" },
      { at: "10-07 11:00", who: "curl" }, { at: "10-07 12:30", who: "touch" },
    ],
    comments: [{ at: "10-07 00:15", who: "mid", body: "옛날 시즌 팀 구성 찾느라 고생했는데 감사합니다." }],
  },
  {
    key: "fc30", at: "10-07 12:20", who: "curl", game: "fconline", topic: "question",
    title: "FC 상대전적은 최근 경기만 나오나요?",
    body: "예전 경기가 안 보여서요. 넥슨 쪽에서 최근 30일치만 준다는 말이 있던데 맞나요?",
    votes: [{ at: "10-07 12:50", who: "touch" }],
    comments: [
      { key: "fc30-a", at: "10-07 12:48", who: "touch", body: "공식 목록이 최근 30일만 줘서 그 전 경기는 사이트에 미리 쌓아 둔 것만 보인대요." },
      { at: "10-07 13:02", who: "curl", parent: "fc30-a", body: "그럼 꾸준히 쌓아 두는 게 중요하겠네요. 답변 감사합니다." },
    ],
  },
  {
    key: "haru", at: "10-07 18:45", who: "canyon", game: "lol", topic: "free",
    title: "하루98 이야기 하는 곳",
    body: "하루98 방송 보면서 기록 같이 보는 분들 여기 모여요.\n프로필 오른쪽 '이 스트리머 이야기'로 들어오면 이 글이 보여요.",
    tags: ["alstmdharu1"],
    votes: [{ at: "10-07 19:12", who: "mid" }],
    comments: [{ at: "10-07 19:10", who: "mid", body: "프로필에서 타고 들어왔어요." }],
  },
  {
    key: "nick", at: "10-08 09:10", who: "curl", game: null, topic: "question",
    title: "닉네임 바꿀 수 있나요?",
    body: "가입할 때 대충 정했는데 나중에 바꿀 수 있는지 궁금합니다.",
    comments: [{ at: "10-08 09:31", who: "jungle", body: "내 정보 화면에서 바꿀 수 있어요." }],
  },
  {
    key: "versus-fc", at: "10-08 14:33", who: "curl", game: "fconline", topic: "match",
    title: "정준홍 vs 우질 경기 이야기",
    body: "두 분 맞대결 기록이 꽤 쌓였네요.\n다시보기 링크 있으면 댓글로 공유해 주세요.",
    tags: ["x2122x", "clzhf123"],
    votes: [{ at: "10-08 14:50", who: "touch" }, { at: "10-08 15:20", who: "canyon" }],
    comments: [{ at: "10-08 15:02", who: "touch", body: "SOOP 다시보기에서 찾아보면 있을 거예요 https://www.sooplive.co.kr" }],
  },
  {
    key: "tonight", at: "10-08 17:20", who: "jungle", game: "lol", topic: "match",
    title: "다음 내전 일정 같이 봐요",
    body: "편성표에 다음 내전 일정 올라오면 여기서 같이 이야기해요.\n누가 어느 라인 설지 미리 예상해 보는 것도 재밌을 듯합니다.",
  },
];

type Event =
  | { at: Date; kind: "post"; post: SamplePost }
  | { at: Date; kind: "comment"; post: SamplePost; comment: SampleComment }
  | { at: Date; kind: "vote"; post: SamplePost; who: Who };

/** 모든 쓰기를 시간 순서로 — 같은 시각이면 글 → 댓글 → 추천(정렬이 안정적이라 선언 순서도 지킨다). */
function timeline(): Event[] {
  const events: Event[] = [];
  for (const post of POSTS) {
    events.push({ at: at(post.at), kind: "post", post });
    for (const comment of post.comments ?? []) events.push({ at: at(comment.at), kind: "comment", post, comment });
    for (const vote of post.votes ?? []) events.push({ at: at(vote.at), kind: "vote", post, who: vote.who });
  }
  const order = { post: 0, comment: 1, vote: 2 };
  return events.sort((a, b) => a.at.getTime() - b.at.getTime() || order[a.kind] - order[b.kind]);
}

async function add(): Promise<void> {
  const sql = db();
  const [existing] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM member WHERE id = ANY(${SAMPLE_IDS}::uuid[])`;
  if (existing.n > 0) throw new Error("샘플이 이미 들어 있다 — 다시 넣으려면 --remove 먼저");

  const slugs = [...new Set(POSTS.flatMap((p) => p.tags ?? []))];
  const found = await sql<{ slug: string; streamer_id: string }[]>`
    SELECT slug, streamer_id FROM core_public.streamer WHERE slug = ANY(${slugs})`;
  const streamerId = new Map(found.map((r) => [r.slug, r.streamer_id]));
  const missing = slugs.filter((s) => !streamerId.has(s));
  if (missing.length) throw new Error(`공개 명부에 없는 스트리머: ${missing.join(", ")}`);

  const events = timeline();
  const latest = events.at(-1)!.at;
  if (latest > new Date()) throw new Error(`샘플 시각이 지금보다 뒤다(${latest.toISOString()}) — 시각을 고친다`);

  // 회원: 처음 쓰기 한 시간 전에 가입한 것으로. 세션은 넣는 동안만 쓰고 지운다.
  const firstAt = new Map<Who, Date>();
  for (const e of events) {
    const who = e.kind === "post" ? e.post.who : e.kind === "comment" ? e.comment.who : e.who;
    if (!firstAt.has(who)) firstAt.set(who, e.at);
  }
  const tokens = new Map<Who, string>();
  try {
    for (const [who, first] of firstAt) {
      const joined = new Date(first.getTime() - 60 * 60_000);
      await sql`INSERT INTO member (id, created_at) VALUES (${MEMBERS[who].id}::uuid, ${joined})`;
      const { token } = await createSession(MEMBERS[who].id, joined);
      tokens.set(who, token);
      await setNickname(token, MEMBERS[who].nickname, { agreed: true }, joined);
    }

    const notice = await createNotice({ game_code: NOTICE.game_code, title: NOTICE.title, body: NOTICE.body }, NOTICE.at);
    const postId = new Map<string, number>();
    const commentId = new Map<string, number>();
    let comments = 0, votes = 0;
    for (const e of events) {
      if (e.kind === "post") {
        const { id } = await createPost(tokens.get(e.post.who), {
          game_code: e.post.game, topic: e.post.topic, title: e.post.title, body: e.post.body,
          streamer_ids: (e.post.tags ?? []).map((s) => streamerId.get(s)!),
        }, e.at);
        postId.set(e.post.key, id);
      } else if (e.kind === "comment") {
        const parent = e.comment.parent ? commentId.get(e.comment.parent)! : null;
        const { id } = await createComment(tokens.get(e.comment.who), postId.get(e.post.key)!, e.comment.body, parent, e.at);
        if (e.comment.key) commentId.set(e.comment.key, id);
        comments++;
      } else {
        await votePost(tokens.get(e.who), postId.get(e.post.key)!, e.at);
        votes++;
      }
    }
    console.log(`넣었다 — 회원 ${firstAt.size} · 공지 1(#${notice.id}) · 글 ${postId.size} · 댓글 ${comments} · 추천 ${votes}`);
  } catch (error) {
    console.error("중간에 멈췄다 — 들어간 것까지 지우려면 --remove");
    throw error;
  } finally {
    for (const token of tokens.values()) await deleteSession(token);
  }
}

async function remove(): Promise<void> {
  const removed = await db().begin(async (tx) => {
    const posts = (await tx<{ id: number }[]>`
      SELECT id::int AS id FROM community_post
       WHERE author_id = ANY(${SAMPLE_IDS}::uuid[])
          OR (author_id IS NULL AND topic = 'notice' AND title = ${NOTICE.title} AND created_at = ${NOTICE.at})`).map((r) => r.id);
    const comments = (await tx<{ id: number }[]>`
      SELECT id::int AS id FROM community_comment
       WHERE post_id = ANY(${posts}::bigint[]) OR author_id = ANY(${SAMPLE_IDS}::uuid[])`).map((r) => r.id);
    const targets = (kind: string) => kind === "post" ? posts : comments;
    for (const kind of ["post", "comment"]) {
      await tx`DELETE FROM community_report WHERE kind = ${kind} AND target_id = ANY(${targets(kind)}::bigint[])`;
      await tx`DELETE FROM community_moderation_log WHERE kind = ${kind} AND target_id = ANY(${targets(kind)}::bigint[])`;
    }
    await tx`DELETE FROM community_report WHERE reporter_id = ANY(${SAMPLE_IDS}::uuid[])`;
    await tx`DELETE FROM community_post_vote WHERE member_id = ANY(${SAMPLE_IDS}::uuid[])`;
    // 샘플 회원이 남의 글에 단 댓글(답글은 FK 로 같이), 그다음 샘플 글(댓글·추천·태그는 FK 로 같이)
    await tx`DELETE FROM community_comment WHERE author_id = ANY(${SAMPLE_IDS}::uuid[])`;
    await tx`DELETE FROM community_post WHERE id = ANY(${posts}::bigint[])`;
    await tx`DELETE FROM community_sanction WHERE member_id = ANY(${SAMPLE_IDS}::uuid[])`;
    const members = await tx`DELETE FROM member WHERE id = ANY(${SAMPLE_IDS}::uuid[]) RETURNING 1`;   // 세션은 FK 로 같이
    return { posts: posts.length, comments: comments.length, members: members.length };
  });
  console.log(`지웠다 — 글 ${removed.posts}(공지 포함) · 댓글 ${removed.comments} · 회원 ${removed.members}`);
}

try {
  await (process.argv.includes("--remove") ? remove() : add());
} catch (error) {
  console.error(`실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
