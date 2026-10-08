/**
 * 커뮤니티 기록(쓰기 경로·공개 경계·운영·파기)을 실제 Postgres(PGlite)에서 확인한다 — verify-db.ts 가 부른다.
 * docs/COMMUNITY-PLAN.md §8 "verify:db — 커뮤니티"
 *
 * ★ 회원 쓰기에는 **실제로 발급한 세션 토큰**을 넘긴다 — 검사를 건너뛰는 시험용 함수가 없다.
 * ★ 공개 경계는 화면이 쓰는 공개 읽기 함수(core_public 뷰)로 본다. 원본 표를 직접 읽는 것은 "남았는지" 확인할 때뿐이다.
 * ★ 시각은 now 인자로 움직인다(쓰기 한도·파기 30일·검토 30일).
 */

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

const DAY = 86_400_000;

export async function verifyCommunityDb(check: Check, expectReject: ExpectReject): Promise<void> {
  const { db } = await import("../../packages/core/lib/db/client.ts");
  const member = await import("../../packages/core/lib/db/member.ts");
  const community = await import("../../packages/core/lib/db/community.ts");
  const admin = await import("../../packages/core/lib/db/community-admin.ts");
  const pub = await import("../../packages/core/lib/db/community-public.ts");
  const sql = db();

  const T0 = new Date("2026-12-01T03:00:00Z");
  let clock = T0;
  /** 쓰기마다 시계를 넘긴다(기본 2분 — 쓰기 한도에 걸리지 않게). */
  const tick = (ms = 120_000) => (clock = new Date(clock.getTime() + ms));
  const at = (days: number) => new Date(T0.getTime() + days * DAY);

  // ── 준비: 스트리머(공개 둘·숨김 하나), 회원(작성자·다른 회원·제재 대상·닉네임 없음) ──
  const [sA] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES ('cm-a', '커뮤A') RETURNING id`;
  const [sB] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES ('cm-b', '커뮤B') RETURNING id`;
  const [sH] = await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name, visibility) VALUES ('cm-h', '커뮤숨김', 'hidden') RETURNING id`;
  const join = async (sub: string, nickname: string | null) => {
    const r = await member.loginWithIdentity("kakao", sub, T0);
    if (r.kind !== "ok") throw new Error("가입 실패");
    const { token } = await member.createSession(r.memberId, T0);
    if (nickname) await member.setNickname(token, nickname, { agreed: true }, T0);
    return { id: r.memberId, token };
  };
  const W = await join("cm-writer", "작성자");
  const O = await join("cm-other", "다른회원");
  const S = await join("cm-sanctioned", "제재대상");
  const N = await join("cm-nonick", null);
  const post = (over: Partial<import("../../packages/core/lib/metrics/community.ts").PostInput> = {}) => ({
    game_code: "lol" as const, topic: "free" as const, title: "롤 이야기", body: "본문", streamer_ids: [] as string[], ...over,
  });
  const list = (q: Partial<import("../../packages/core/lib/db/community-public.ts").CommunityListQuery> = {}) =>
    pub.listPublicCommunityPosts({ game: null, topic: null, streamer: null, author: null, cursor: null, ...q });
  const ids = (rows: { post_id: number }[]) => rows.map((r) => r.post_id);

  console.log("\n▸ 커뮤니티 — 쓰기 경로");
  const p1 = await community.createPost(W.token, post({ title: "둘 다 태그", streamer_ids: [sA.id, sB.id] }), tick());
  check("회원이 글을 쓴다(토큰 → 작성자)", (await pub.getPublicCommunityPost(p1.id))?.author_id === W.id);
  await expectReject("1분 안에 두 번째 글은 쓰기 한도에 걸린다", () => community.createPost(W.token, post({ title: "연달아" }), new Date(clock.getTime() + 30_000)), "1분에 1개");
  await expectReject("회원은 공지를 쓸 수 없다", () => community.createPost(W.token, post({ topic: "notice" }), tick()), "말머리");
  await expectReject("숨긴 스트리머는 태그할 수 없다", () => community.createPost(W.token, post({ streamer_ids: [sH.id] }), tick()), "태그할 수 없는");
  await expectReject("닉네임이 없으면 쓸 수 없다(읽기만)", () => community.createPost(N.token, post(), tick()), "닉네임");
  await expectReject("로그인 안 하면 쓸 수 없다", () => community.createPost(null, post(), tick()), "로그인이 필요합니다");
  const p2 = await community.createPost(O.token, post({ game_code: null, title: "기타 글", streamer_ids: [sA.id] }), tick());
  const p3 = await community.createPost(O.token, post({ game_code: "fconline", title: "FC 글" }), tick());

  console.log("\n▸ 커뮤니티 — 분류와 공개 경계");
  const all = ids((await list()).posts);
  const lol = ids((await list({ game: "lol" })).posts);
  const etc = ids((await list({ game: "etc" })).posts);
  check("전체 목록은 기타 + 모든 게임", [p1.id, p2.id, p3.id].every((id) => all.includes(id)));
  check("★ ?game=lol 목록에 기타 글이 섞이지 않는다", lol.includes(p1.id) && !lol.includes(p2.id) && !lol.includes(p3.id), JSON.stringify(lol));
  check("?game=etc 는 기타 글만", etc.includes(p2.id) && !etc.includes(p1.id), JSON.stringify(etc));
  const onlyA = ids((await list({ streamer: "cm-a" })).posts);
  check("?s= 는 그 스트리머가 태그된 글", onlyA.includes(p1.id) && onlyA.includes(p2.id) && !onlyA.includes(p3.id));
  check("작성자 필터(member.id)", ids((await list({ author: O.id })).posts).sort().join() === [p2.id, p3.id].sort().join());
  await sql`INSERT INTO community_post_streamer (post_id, streamer_id) VALUES (${p1.id}, ${sH.id})`; // 접근자를 거치지 않고 넣어 본다
  const p1Public = await pub.getPublicCommunityPost(p1.id);
  const tagRows = await sql`SELECT 1 FROM core_public.community_post_streamer WHERE post_id = ${p1.id} AND streamer_id = ${sH.id}`;
  check("★ 숨긴 스트리머의 태그는 공개 뷰·글 상세 어디에도 없다", tagRows.length === 0 && !p1Public!.streamers.some((s) => s.streamer_id === sH.id));
  await sql`DELETE FROM community_post_streamer WHERE post_id = ${p1.id} AND streamer_id = ${sH.id}`;

  const nAll = await admin.createNotice({ game_code: null, title: "모든 게임 공지", body: "모두에게" }, tick());
  const nLol = await admin.createNotice({ game_code: "lol", title: "롤 공지", body: "롤만" }, tick());
  const noticeIds = async (g: Parameters<typeof pub.listPublicNotices>[0]) => (await pub.listPublicNotices(g, 10)).map((n) => n.post_id);
  check("공지 띠 — 모든 게임 공지는 모든 게임 필터에, 게임 공지는 그 게임에",
    (await noticeIds("lol")).join() === [nLol.id, nAll.id].join() && (await noticeIds("fconline")).join() === String(nAll.id)
      && (await noticeIds("etc")).join() === String(nAll.id));
  check("공지는 목록에 섞이지 않는다", !ids((await list()).posts).includes(nAll.id));
  const [noticeRow] = await sql<{ author_id: string | null }[]>`SELECT author_id FROM community_post WHERE id = ${nAll.id}`;
  await expectReject("DB 도 회원이 쓴 공지를 막는다('작성자 없음 = 공지' 짝)",
    () => sql`INSERT INTO community_post (author_id, topic, title, body) VALUES (${W.id}::uuid, 'notice', 't', 'b')`, "check constraint");
  check("공지 작성자는 운영자(작성자 없음)", noticeRow.author_id === null);

  console.log("\n▸ 커뮤니티 — 수정·version·추천·댓글");
  const v1 = p1Public!.version;
  await expectReject("남의 글은 고칠 수 없다(소유)", () => community.editPost(O.token, p1.id, post({ title: "남의 글" }), v1, tick()), "고칠 수 없는 글");
  await expectReject("오래된 version 이면 거부한다", () => community.editPost(W.token, p1.id, post({ title: "x" }), "2000-01-01 00:00:00+00", tick()), "먼저 고쳤습니다");
  const e1 = await community.editPost(W.token, p1.id, post({ title: "둘 다 태그", streamer_ids: [sA.id] }), v1, tick());
  check("★ 태그만 바꿔도 version 이 바뀐다(문자열 그대로 돌려보내면 통과)", e1.version !== v1 && (await pub.getPublicCommunityPost(p1.id))!.version === e1.version);
  check("수정하면 태그가 바뀐 대로 남는다", (await pub.getPublicCommunityPost(p1.id))!.streamers.map((s) => s.slug).join() === "cm-a");
  await expectReject("오래된 폼(이전 version)은 태그를 덮어쓰지 못한다", () => community.editPost(W.token, p1.id, post({ title: "둘 다 태그", streamer_ids: [sA.id, sB.id] }), v1, tick()), "먼저 고쳤습니다");

  const vote1 = await community.votePost(O.token, p1.id, tick());
  const vote2 = await community.votePost(O.token, p1.id, tick());
  await expectReject("내 글은 추천할 수 없다", () => community.votePost(W.token, p1.id, tick()), "내 글은");
  const afterVote = await pub.getPublicCommunityPost(p1.id);
  check("추천은 한 사람에 한 번 — 두 번 눌러도 1", vote1.added && !vote2.added && afterVote!.like_count === 1, JSON.stringify({ vote1, vote2, like: afterVote?.like_count }));
  check("내 추천 여부를 읽는다", (await community.votedPostIds(O.token, [p1.id, p2.id])).has(p1.id) && !(await community.votedPostIds(W.token, [p1.id])).has(p1.id));

  const c1 = await community.createComment(O.token, p1.id, "첫 댓글", null, tick());
  const c2 = await community.createComment(W.token, p1.id, "답글", c1.id, tick());
  await expectReject("답글에는 다시 답글을 달 수 없다", () => community.createComment(O.token, p1.id, "답글의 답글", c2.id, tick()), "답글에는");
  await expectReject("다른 글의 댓글에는 답글을 달 수 없다(접근자)", () => community.createComment(O.token, p2.id, "엉뚱한 답글", c1.id, tick()), "같은 글의");
  await expectReject("★ DB 도 다른 글의 댓글을 부모로 삼지 못하게 막는다(복합 FK)",
    () => sql`INSERT INTO community_comment (post_id, parent_id, author_id, body) VALUES (${p2.id}, ${c1.id}, ${O.id}::uuid, 'x')`, "foreign key");
  check("추천·댓글이 달려도 글의 version 은 그대로", (await pub.getPublicCommunityPost(p1.id))!.version === e1.version);

  const visibleCount = async (postId: number) => (await pub.listPublicCommunityComments(postId)).filter((c) => c.visible).length;
  const counted = async () => (await pub.getPublicCommunityPost(p1.id))!.comment_count;
  const c3 = await community.createComment(O.token, p1.id, "숨길 댓글", null, tick());
  await admin.moderateContent("comment", c3.id, "hide", "욕설", "admin", tick());
  const hiddenCount = [await counted(), await visibleCount(p1.id)];
  await admin.moderateContent("comment", c3.id, "restore", "오판", "admin", tick());
  const restoredCount = [await counted(), await visibleCount(p1.id)];
  check("★ 댓글 숨김·해제 뒤 공개 댓글 수 = 보이는 댓글 수(수를 저장하지 않는다)",
    hiddenCount[0] === hiddenCount[1] && hiddenCount[0] === 2 && restoredCount[0] === restoredCount[1] && restoredCount[0] === 3,
    JSON.stringify({ hiddenCount, restoredCount }));
  await community.deleteComment(O.token, c1.id, tick());
  const thread = await pub.listPublicCommunityComments(p1.id);
  const placeholder = thread.find((c) => c.comment_id === c1.id);
  check("지운 댓글은 공개 대댓글이 있을 때만 자리로 남는다(본문·작성자 없이)",
    placeholder !== undefined && !placeholder.visible && placeholder.body === null && placeholder.author_id === null, JSON.stringify(placeholder));
  await expectReject("지운 댓글에는 답글을 달 수 없다", () => community.createComment(W.token, p1.id, "늦은 답글", c1.id, tick()), "지운 댓글");

  console.log("\n▸ 커뮤니티 — 운영 조치");
  const p4 = await community.createPost(W.token, post({ title: "숨겨질 글" }), tick());
  const c4 = await community.createComment(O.token, p4.id, "숨겨질 글의 댓글", null, tick());
  const v4 = (await pub.getPublicCommunityPost(p4.id))!.version;
  await admin.moderateContent("post", p4.id, "hide", "개인정보 노출", "admin", tick());
  check("숨긴 글은 공개 목록·상세에 없다", !ids((await list()).posts).includes(p4.id) && (await pub.getPublicCommunityPost(p4.id)) === null);
  check("숨긴 글의 댓글은 공개 뷰에 없다", (await pub.listPublicCommunityComments(p4.id)).length === 0
    && (await sql`SELECT 1 FROM core_public.community_comment WHERE comment_id = ${c4.id}`).length === 0);
  await expectReject("★ 숨긴 글은 작성자가 고칠 수 없다(고쳐서 다시 공개되지 않는다)", () => community.editPost(W.token, p4.id, post({ title: "고쳐서 살리기" }), v4, tick()), "고칠 수 없습니다");
  await expectReject("숨긴 글의 댓글도 고칠 수 없다", () => community.editComment(O.token, c4.id, "고침", "x", tick()), "고칠 수 없습니다");
  await community.deletePost(W.token, p4.id, tick());
  const [p4Row] = await sql<{ status: string }[]>`SELECT status FROM community_post WHERE id = ${p4.id}`;
  const p4Log = await sql`SELECT 1 FROM community_moderation_log WHERE kind = 'post' AND target_id = ${p4.id} AND action = 'hide'`;
  check("작성자는 숨긴 글도 지울 수 있고, 숨겼다는 기록은 남는다", p4Row.status === "deleted" && p4Log.length === 1);
  await expectReject("★ 삭제된 글은 해제로 되살리지 않는다", () => admin.moderateContent("post", p4.id, "restore", "되살리기", "admin", tick()), "되살리지");
  await expectReject("처리 사유가 없으면 거부한다", () => admin.moderateContent("post", p1.id, "hide", "  ", "admin", tick()), "사유");

  await admin.addSanction(S.id, 7, "도배", "admin", tick());
  await expectReject("제재 중이면 글을 쓸 수 없다", () => community.createPost(S.token, post(), tick()), "쓸 수 없습니다");
  await expectReject("제재 중이면 추천도 할 수 없다", () => community.votePost(S.token, p1.id, tick()), "쓸 수 없습니다");
  const sanctionId = (await member.sanctionsOf(sql, S.id))[0].id;
  await admin.liftSanction(sanctionId, tick());
  const afterLift = await community.createPost(S.token, post({ title: "풀린 뒤" }), tick());
  check("제재를 풀면 다시 쓸 수 있다", afterLift.id > 0);

  console.log("\n▸ 커뮤니티 — 신고");
  await community.reportContent(O.token, "post", p1.id, "defamation", "허위사실", tick());
  const [snap] = await sql<{ snapshot_title: string; snapshot_body: string }[]>`
    SELECT snapshot_title, snapshot_body FROM community_report WHERE kind = 'post' AND target_id = ${p1.id}`;
  check("신고 당시 제목·본문이 신고 행에 남는다", snap.snapshot_title === "둘 다 태그" && snap.snapshot_body === "본문");
  const vNow = (await pub.getPublicCommunityPost(p1.id))!.version;
  await community.editPost(W.token, p1.id, post({ title: "신고 뒤 고친 제목", body: "고친 본문", streamer_ids: [sA.id] }), vNow, tick());
  const [snapAfter] = await sql<{ snapshot_title: string }[]>`SELECT snapshot_title FROM community_report WHERE kind = 'post' AND target_id = ${p1.id}`;
  const queue = await admin.listReportQueue();
  const queued = queue.find((q) => q.kind === "post" && q.target_id === p1.id);
  check("★ 신고만으로 수정을 막지 않는다 — 신고 뒤 고쳐도 신고 당시 내용은 그대로, 관리자 목록은 '신고 뒤 수정됨'",
    snapAfter.snapshot_title === "둘 다 태그" && queued?.edited_after_report === true && queued.title === "신고 뒤 고친 제목");
  check("관리자 목록은 개인정보·명예훼손 신고가 먼저", queue[0]?.urgent === true);
  await expectReject("같은 대상을 두 번 신고할 수 없다", () => community.reportContent(O.token, "post", p1.id, "spam", null, tick()), "이미 신고");
  await expectReject("내 글은 신고할 수 없다", () => community.reportContent(W.token, "post", p1.id, "spam", null, tick()), "내 글은");
  await expectReject("기타 사유는 설명이 필요하다", () => community.reportContent(S.token, "post", p1.id, "other", " ", tick()), "설명");
  await expectReject("공개가 아닌 글은 신고를 받지 않는다", () => community.reportContent(O.token, "post", p4.id, "spam", null, tick()), "신고할 수 없는");
  await community.reportContent(W.token, "comment", c3.id, "abuse", null, tick());
  const [cSnap] = await sql<{ snapshot_title: string | null; snapshot_body: string }[]>`
    SELECT snapshot_title, snapshot_body FROM community_report WHERE kind = 'comment' AND target_id = ${c3.id}`;
  check("댓글 신고도 당시 본문을 남긴다(제목 없음)", cSnap.snapshot_title === null && cSnap.snapshot_body === "숨길 댓글");

  const handledAt = tick();
  await admin.moderateContent("post", p1.id, "keep", "허위 아님", "admin", handledAt);
  const [closed] = await sql<{ status: string; handled_at: Date }[]>`SELECT status, handled_at FROM community_report WHERE kind = 'post' AND target_id = ${p1.id}`;
  check("유지 처리하면 열린 신고가 기각으로 닫힌다", closed.status === "dismissed" && closed.handled_at.getTime() === handledAt.getTime());
  await admin.clearHandledSnapshots(new Date(handledAt.getTime() + 29 * DAY));
  const kept = await sql`SELECT 1 FROM community_report WHERE kind = 'post' AND target_id = ${p1.id} AND snapshot_body IS NOT NULL`;
  await admin.clearHandledSnapshots(new Date(handledAt.getTime() + 31 * DAY));
  const cleared = await sql`SELECT 1 FROM community_report WHERE kind = 'post' AND target_id = ${p1.id} AND snapshot_body IS NULL AND snapshot_title IS NULL`;
  check("처리 30일 뒤 신고 당시 내용을 비운다(전에는 남긴다)", kept.length === 1 && cleared.length === 1);

  console.log("\n▸ 커뮤니티 — 파기");
  const delAt = at(1);
  const p5 = await community.createPost(W.token, post({ title: "파기될 글", streamer_ids: [sB.id] }), delAt);
  await community.votePost(O.token, p5.id, new Date(delAt.getTime() + 1000));
  const c5 = await community.createComment(O.token, p5.id, "파기될 글의 댓글", null, new Date(delAt.getTime() + 2000));
  await community.reportContent(W.token, "comment", c5.id, "spam", null, new Date(delAt.getTime() + 3000));
  await admin.moderateContent("comment", c5.id, "keep", "스팸 아님", "admin", new Date(delAt.getTime() + 4000));
  await community.deletePost(W.token, p5.id, new Date(delAt.getTime() + 5000));
  const p5DeletedAt = new Date(delAt.getTime() + 5000);
  const early = await admin.purgeDeletedContent(new Date(p5DeletedAt.getTime() + 29 * DAY));
  const [p5Early] = await sql<{ body: string | null }[]>`SELECT body FROM community_post WHERE id = ${p5.id}`;
  check("삭제 30일 전에는 파기하지 않는다", p5Early.body !== null, JSON.stringify(early));
  await admin.purgeDeletedContent(new Date(p5DeletedAt.getTime() + 31 * DAY));
  const [p5Row] = await sql<{ title: string | null; body: string | null }[]>`SELECT title, body FROM community_post WHERE id = ${p5.id}`;
  const p5Left = await sql<{ n: number }[]>`
    SELECT (SELECT count(*) FROM community_post_streamer WHERE post_id = ${p5.id})
         + (SELECT count(*) FROM community_post_vote WHERE post_id = ${p5.id})
         + (SELECT count(*) FROM community_comment WHERE post_id = ${p5.id} AND body IS NOT NULL) AS n`;
  const [c5Snap] = await sql<{ snapshot_body: string | null }[]>`SELECT snapshot_body FROM community_report WHERE kind = 'comment' AND target_id = ${c5.id}`;
  check("★ 삭제 30일 뒤 제목·본문·태그·추천이 없고, 그 글의 댓글 원문·신고 당시 내용도 없다",
    p5Row.title === null && p5Row.body === null && Number(p5Left[0].n) === 0 && c5Snap.snapshot_body === null, JSON.stringify({ p5Row, n: p5Left[0].n, c5Snap }));

  // 보류: 열린 신고가 있으면 미루고, 처리한 뒤에도 30일은 미룬다
  const p6 = await community.createPost(W.token, post({ title: "분쟁 글" }), at(2));
  await community.reportContent(O.token, "post", p6.id, "privacy", null, new Date(at(2).getTime() + 1000));
  await community.deletePost(W.token, p6.id, new Date(at(2).getTime() + 2000));
  const heldRun = await admin.purgeDeletedContent(at(40));
  const [p6Held] = await sql<{ body: string | null }[]>`SELECT body FROM community_post WHERE id = ${p6.id}`;
  check("★ 열린 신고가 있으면 30일이 지나도 파기를 미룬다", p6Held.body !== null && heldRun.held >= 1, JSON.stringify(heldRun));
  await admin.moderateContent("post", p6.id, "keep", "확인 끝", "admin", at(40));
  await admin.purgeDeletedContent(at(60));
  const [p6Still] = await sql<{ body: string | null }[]>`SELECT body FROM community_post WHERE id = ${p6.id}`;
  await admin.purgeDeletedContent(at(71));
  const [p6Gone] = await sql<{ body: string | null }[]>`SELECT body FROM community_post WHERE id = ${p6.id}`;
  check("처리한 뒤에도 30일은 미루고, 그 뒤 파기한다", p6Still.body !== null && p6Gone.body === null);

  // 글은 살아 있고 댓글만 지운 경우
  const p7 = await community.createPost(W.token, post({ title: "살아 있는 글" }), at(3));
  const c7 = await community.createComment(O.token, p7.id, "지울 댓글", null, new Date(at(3).getTime() + 1000));
  await community.deleteComment(O.token, c7.id, new Date(at(3).getTime() + 2000));
  await admin.purgeDeletedContent(at(35));
  const [c7Row] = await sql<{ body: string | null }[]>`SELECT body FROM community_comment WHERE id = ${c7.id}`;
  check("지운 댓글도 30일 뒤 파기한다(글이 살아 있어도)", c7Row.body === null);

  console.log("\n▸ 커뮤니티 — 다시 볼 것·정기 작업");
  const p8 = await community.createPost(W.token, post({ title: "임시조치 글" }), at(4));
  await admin.moderateContent("post", p8.id, "blind", "권리침해 주장", "admin", at(4));
  const reviewEarly = (await admin.listReviewQueue(at(20))).some((r) => r.kind === "post" && r.target_id === p8.id);
  const reviewLate = (await admin.listReviewQueue(at(40))).find((r) => r.kind === "post" && r.target_id === p8.id);
  check("임시조치 30일이 지나면 '다시 볼 것' 에 뜬다(자동 복구 없음)", !reviewEarly && reviewLate?.action === "blind"
    && (await pub.getPublicCommunityPost(p8.id)) === null);
  const housekeep = await admin.runCommunityHousekeep(at(120));
  check("정기 작업이 파기·정리 건수를 돌려준다", typeof housekeep.posts === "number" && typeof housekeep.sessions === "number", JSON.stringify(housekeep));
}
