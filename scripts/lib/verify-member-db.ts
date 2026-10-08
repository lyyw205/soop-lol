/**
 * 회원(소셜 로그인·세션·닉네임·탈퇴와 재가입)을 실제 Postgres(PGlite)에서 확인한다 — verify-db.ts 가 부른다.
 * docs/COMMUNITY-PLAN.md §8 "verify:db — 회원"
 *
 * ★ 가짜는 HTTP 경계 하나뿐이다. 로그인은 openid-client 를 그대로 쓰고, 제공자만 customFetch 로 가짜를 단다
 *   (scripts/fake-riot.ts 와 같은 자리). 회원 접근자에는 **실제로 발급한 세션 토큰**을 넘긴다 — 검사를 건너뛰는 시험용 함수가 없다.
 */

import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

type Check = (name: string, ok: boolean, detail?: string) => void;
type ExpectReject = (name: string, fn: () => Promise<unknown>, expected: string) => Promise<void>;

const DAY = 86_400_000;
const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** 가짜 OIDC 제공자. 토큰 엔드포인트만 HTTP 로 흉내 낸다 — 코드 한 번만 · PKCE · redirect_uri 를 실제처럼 검사한다. */
function fakeProvider(issuer: string, clientId: string) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; sub: string; used: boolean }>();
  let nonceOverride: string | null = null;
  const idToken = (sub: string, nonce: string) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
    const body = b64url(JSON.stringify({ iss: issuer, aud: clientId, sub, nonce, iat: now, exp: now + 300 }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  };
  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  return {
    server: {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ["RS256"],
    },
    /** 사용자가 제공자 화면에서 승인했다고 치고 인가 코드를 낸다. */
    approve(authUrl: URL, sub: string) {
      const code = b64url(randomBytes(12));
      codes.set(code, {
        challenge: authUrl.searchParams.get("code_challenge") ?? "",
        redirectUri: authUrl.searchParams.get("redirect_uri") ?? "",
        nonce: authUrl.searchParams.get("nonce") ?? "",
        sub, used: false,
      });
      return code;
    },
    /** 다음 ID 토큰의 nonce 를 바꾼다(nonce 검사가 켜져 있는지 확인용). */
    tamperNonce(value: string | null) { nonceOverride = value; },
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input);
      if (url !== `${issuer}/token`) return json(404, { error: "not_found" });
      const form = new URLSearchParams(String(init?.body ?? ""));
      const entry = codes.get(form.get("code") ?? "");
      if (!entry || entry.used) return json(400, { error: "invalid_grant", error_description: "code" });
      entry.used = true;
      const verifier = form.get("code_verifier") ?? "";
      if (b64url(createHash("sha256").update(verifier).digest()) !== entry.challenge) {
        return json(400, { error: "invalid_grant", error_description: "pkce" });
      }
      if (form.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant", error_description: "redirect_uri" });
      return json(200, { access_token: "fake-access", token_type: "Bearer", expires_in: 300, id_token: idToken(entry.sub, nonceOverride ?? entry.nonce) });
    },
  };
}

/**
 * openid-client 의 오류는 문구가 일반적이다("invalid response encountered"). 어떤 검사에서 막혔는지는
 * code·error·error_description·cause 에 있으므로 그걸 모아 판정한다 — 아무 오류나 통과로 치지 않는다.
 */
function errorDetail(e: unknown, depth = 0): string {
  if (!(e instanceof Error)) {
    if (e === undefined || e === null) return "";
    try { return JSON.stringify(e); } catch { return String(e); }
  }
  const x = e as Error & { code?: string; error?: string; error_description?: string; cause?: unknown };
  // 바깥 오류는 code 만 있고 구체적인 사유(어떤 값이 어긋났나)는 안쪽 cause 의 메시지에 있다.
  const inner = depth < 3 ? errorDetail(x.cause, depth + 1) : "";
  return [x.message, x.code, x.error, x.error_description, inner].filter(Boolean).join(" | ");
}

export async function verifyMemberDb(check: Check, expectReject: ExpectReject): Promise<void> {
  const rejectsWith = async (name: string, fn: () => Promise<unknown>, needle: string) => {
    try {
      await fn();
      check(name, false, "거부되어야 하는데 통과했다");
    } catch (e) {
      const detail = errorDetail(e);
      check(name, detail.includes(needle), detail.includes(needle) ? "" : detail);
    }
  };
  const client = await import("openid-client");
  const { db } = await import("../../packages/core/lib/db/client.ts");
  const oauth = await import("../../packages/core/lib/auth/oauth.ts");
  const member = await import("../../packages/core/lib/db/member.ts");
  const { hashSessionToken } = await import("../../packages/core/lib/auth/session.ts");
  const sql = db();

  console.log("\n▸ 회원 — 소셜 로그인(가짜 제공자 · openid-client 그대로)");
  const issuer = "https://fake-idp.test";
  const fake = fakeProvider(issuer, "verify-client");
  const config = new client.Configuration(fake.server, "verify-client", undefined, client.None());
  config[client.customFetch] = fake.fetch as never;
  const redirectUri = "http://localhost:3000/auth/kakao/callback";
  const login = async (sub: string) => {
    const { url, state } = await oauth.startLogin(config, "kakao", redirectUri, "/community?game=lol");
    const code = fake.approve(url, sub);
    return { url, state, cookie: oauth.encodeLoginState(state), callback: new URL(`${redirectUri}?code=${code}&state=${state.state}`) };
  };

  const ok = await login("kakao-sub-1");
  check("인가 주소에 PKCE(S256)·state·nonce 가 실린다",
    ok.url.searchParams.get("code_challenge_method") === "S256" && Boolean(ok.url.searchParams.get("state")) && Boolean(ok.url.searchParams.get("nonce")));
  const done = await oauth.finishLogin(config, "kakao", ok.cookie, ok.callback);
  check("콜백 → 제공자의 sub 와 돌아갈 주소를 돌려준다", done.subject === "kakao-sub-1" && done.next === "/community?game=lol", JSON.stringify(done));
  await rejectsWith("같은 콜백을 다시 보내면(코드 재사용) 제공자가 거부한다", () => oauth.finishLogin(config, "kakao", ok.cookie, ok.callback), "invalid_grant | code");
  await expectReject("로그인 상태 쿠키가 없으면(이미 쓰고 지움) 거부한다", () => oauth.finishLogin(config, "kakao", null, ok.callback), "로그인 상태가 없습니다");

  const mixed = await login("kakao-sub-2");
  await expectReject("다른 제공자의 콜백 주소로 오면 거부한다(제공자 혼동)", () => oauth.finishLogin(config, "google", mixed.cookie, mixed.callback), "다른 제공자");

  const badState = await login("kakao-sub-3");
  const tampered = new URL(badState.callback); tampered.searchParams.set("state", "forged");
  await rejectsWith("state 가 다르면 거부한다", () => oauth.finishLogin(config, "kakao", badState.cookie, tampered), "state");

  const badPkce = await login("kakao-sub-4");
  const wrongVerifier = oauth.encodeLoginState({ ...badPkce.state, verifier: client.randomPKCECodeVerifier() });
  await rejectsWith("PKCE 검증값이 다르면 제공자가 거부한다", () => oauth.finishLogin(config, "kakao", wrongVerifier, badPkce.callback), "invalid_grant | pkce");

  const badNonce = await login("kakao-sub-5");
  fake.tamperNonce("forged-nonce");
  await rejectsWith("★ ID 토큰의 nonce 가 다르면 거부한다(라이브러리 검사가 켜져 있다)", () => oauth.finishLogin(config, "kakao", badNonce.cookie, badNonce.callback), "nonce");
  fake.tamperNonce(null);

  const stale = await login("kakao-sub-6");
  await expectReject("로그인 상태가 10분을 넘으면 거부한다", () => oauth.finishLogin(config, "kakao", stale.cookie, stale.callback, Date.now() + 11 * 60_000), "시간이 지났습니다");

  check("돌아갈 주소는 내부 주소만 — 외부·프로토콜 상대·역슬래시 주소는 첫 화면으로",
    oauth.safeNextPath("//evil.example/x") === "/" && oauth.safeNextPath("https://evil.example") === "/"
      && oauth.safeNextPath("/\\evil.example") === "/" && oauth.safeNextPath("/community?game=lol") === "/community?game=lol");

  console.log("\n▸ 회원 — 가입·세션·닉네임");
  const T0 = new Date("2026-11-01T00:00:00Z");
  const first = await member.loginWithIdentity("kakao", "member-a", T0);
  check("처음 로그인하면 회원을 만들고 닉네임을 정하게 한다", first.kind === "ok" && first.needsNickname);
  const again = await member.loginWithIdentity("kakao", "member-a", T0);
  check("같은 제공자 id 는 같은 회원이다", first.kind === "ok" && again.kind === "ok" && again.memberId === first.memberId);
  const memberA = first.kind === "ok" ? first.memberId : "";

  const { token: tokenA } = await member.createSession(memberA, T0);
  const stored = await sql<{ token_hash: Buffer }[]>`SELECT token_hash FROM member_session WHERE member_id = ${memberA}::uuid`;
  check("세션은 토큰의 sha256 만 저장한다(원문 없음)",
    stored.length === 1 && Buffer.compare(stored[0].token_hash, hashSessionToken(tokenA)) === 0 && !stored[0].token_hash.toString("utf8").includes(tokenA));
  check("세션 토큰으로 회원을 찾는다", (await member.memberFromSession(tokenA, T0))?.member_id === memberA);
  check("30일이 지난 세션은 거부한다", (await member.memberFromSession(tokenA, new Date(T0.getTime() + 31 * DAY))) === null);

  await sql`INSERT INTO streamer (slug, display_name, aliases, visibility) VALUES ('member-imp', '사칭검증', ARRAY['사칭별명'], 'hidden')`;
  await expectReject("처음 닉네임은 약관 동의 없이 정할 수 없다", () => member.setNickname(tokenA, "철수", {}, T0), "동의");
  await expectReject("★ 등록 스트리머 이름(숨긴 사람 포함)과 같은 닉네임은 거부한다", () => member.setNickname(tokenA, "사칭 검증", { agreed: true }, T0), "스트리머");
  await expectReject("등록 스트리머의 별칭과 같은 닉네임도 거부한다", () => member.setNickname(tokenA, "사칭별명", { agreed: true }, T0), "스트리머");
  const named = await member.setNickname(tokenA, " 철수 ", { agreed: true }, T0);
  const [rowA] = await sql<{ nickname: string; agreed_at: Date | null }[]>`SELECT nickname, agreed_at FROM member WHERE id = ${memberA}::uuid`;
  check("동의와 함께 닉네임을 정하면 동의 시각이 남는다", named.nickname === "철수" && rowA.nickname === "철수" && rowA.agreed_at !== null);

  const b = await member.loginWithIdentity("google", "member-b", T0);
  const memberB = b.kind === "ok" ? b.memberId : "";
  const { token: tokenB } = await member.createSession(memberB, T0);
  await expectReject("정규화하면 같은 닉네임(대소문자·공백)은 다른 회원이 쓸 수 없다", () => member.setNickname(tokenB, "철 수", { agreed: true }, T0), "이미 쓰는");
  await member.setNickname(tokenB, "영희", { agreed: true }, T0);

  await member.deleteSession(tokenB);
  check("로그아웃하면 그 세션은 거부한다", (await member.memberFromSession(tokenB, T0)) === null);

  console.log("\n▸ 회원 — 탈퇴와 재가입 제한");
  const { token: tokenB2 } = await member.createSession(memberB, T0);
  const [post] = await sql<{ id: number }[]>`
    INSERT INTO community_post (author_id, topic, title, body) VALUES (${memberB}::uuid, 'free', '탈퇴 전 글', '본문') RETURNING id`;
  await member.withdrawMember(tokenB2, { deleteContent: false }, T0);
  const [rowB] = await sql<{ status: string; nickname: string | null }[]>`SELECT status, nickname FROM member WHERE id = ${memberB}::uuid`;
  const identities = await sql`SELECT 1 FROM member_identity WHERE member_id = ${memberB}::uuid`;
  check("탈퇴하면 닉네임이 지워지고 회원 행·로그인 연결은 남는다", rowB.status === "withdrawn" && rowB.nickname === null && identities.length === 1);
  check("탈퇴하면 세션이 모두 지워진다", (await member.memberFromSession(tokenB2, T0)) === null);
  const [pub] = await sql<{ author_nickname: string | null }[]>`SELECT author_nickname FROM core_public.community_post WHERE post_id = ${post.id}`;
  check("글은 익명(탈퇴한 회원)으로 남는다 — 공개 뷰의 작성자 이름이 비어 있다", pub !== undefined && pub.author_nickname === null);
  await expectReject("탈퇴한 세션 토큰으로는 아무것도 못 한다", () => member.setNickname(tokenB2, "다시영희", { agreed: true }, T0), "로그인이 필요합니다");

  const in10 = await member.loginWithIdentity("google", "member-b", new Date(T0.getTime() + 10 * DAY));
  check("탈퇴 뒤 30일 안에는 같은 소셜 계정으로 다시 가입할 수 없다",
    in10.kind === "blocked" && in10.until.getTime() === T0.getTime() + 30 * DAY, JSON.stringify(in10));
  const in31 = await member.loginWithIdentity("google", "member-b", new Date(T0.getTime() + 31 * DAY));
  check("★ 기간이 끝났으면 로그인 때 바로 새 회원으로 가입한다(정기 작업을 기다리지 않는다)",
    in31.kind === "ok" && in31.memberId !== memberB && in31.needsNickname, JSON.stringify(in31));

  // 탈퇴 29일째 영구 제재 → 31일째에도 연결이 남아야 한다
  const c = await member.loginWithIdentity("kakao", "member-c", T0);
  const memberC = c.kind === "ok" ? c.memberId : "";
  const { token: tokenC } = await member.createSession(memberC, T0);
  await member.withdrawMember(tokenC, { deleteContent: false }, T0);
  const [sanction] = await sql<{ id: number }[]>`
    INSERT INTO community_sanction (member_id, reason, actor, created_at) VALUES (${memberC}::uuid, '탈퇴 뒤 확인된 위반', 'admin', ${new Date(T0.getTime() + 29 * DAY)})
    RETURNING id`;
  const removed31 = await member.cleanupWithdrawnIdentities(new Date(T0.getTime() + 31 * DAY));
  const keptC = await sql`SELECT 1 FROM member_identity WHERE member_id = ${memberC}::uuid`;
  check("★ 탈퇴 뒤 걸린 영구 제재 — 30일이 지나도 정리 작업이 연결을 지우지 않는다", removed31 === 0 && keptC.length === 1, `removed=${removed31}`);
  const c31 = await member.loginWithIdentity("kakao", "member-c", new Date(T0.getTime() + 31 * DAY));
  check("탈퇴 뒤 영구 제재 — 31일째 로그인도 막힌다(제재 + 1년까지)",
    c31.kind === "blocked" && c31.until.getTime() === T0.getTime() + (29 + 365) * DAY, JSON.stringify(c31));
  await sql`UPDATE community_sanction SET lifted_at = ${new Date(T0.getTime() + 30 * DAY)} WHERE id = ${sanction.id}`;
  const removedLifted = await member.cleanupWithdrawnIdentities(new Date(T0.getTime() + 31 * DAY));
  check("제재를 풀면 다시 30일 기준 — 정리 작업이 연결을 지운다", removedLifted === 1, `removed=${removedLifted}`);

  // 제재 중이면 회원 쓰기의 문에서 막힌다
  const d = await member.loginWithIdentity("kakao", "member-d", T0);
  const memberD = d.kind === "ok" ? d.memberId : "";
  const { token: tokenD } = await member.createSession(memberD, T0);
  await member.setNickname(tokenD, "제재검증", { agreed: true }, T0);
  await sql`INSERT INTO community_sanction (member_id, reason, actor, created_at, ends_at)
            VALUES (${memberD}::uuid, '도배', 'admin', ${T0}, ${new Date(T0.getTime() + 7 * DAY)})`;
  await expectReject("제재 중이면 회원 쓰기의 문(lockSessionMember)에서 거부한다",
    () => sql.begin((tx) => member.lockSessionMember(tx, tokenD, new Date(T0.getTime() + DAY), { needNickname: true, checkSanction: true })), "쓸 수 없습니다");
  const afterBan = await sql.begin((tx) => member.lockSessionMember(tx, tokenD, new Date(T0.getTime() + 8 * DAY), { checkSanction: true }));
  check("제재가 끝나면 다시 쓸 수 있다", afterBan.id === memberD);

  // 탈퇴하며 내 글·댓글 지우기
  const e = await member.loginWithIdentity("kakao", "member-e", T0);
  const memberE = e.kind === "ok" ? e.memberId : "";
  const { token: tokenE } = await member.createSession(memberE, T0);
  const [ePost] = await sql<{ id: number }[]>`INSERT INTO community_post (author_id, topic, title, body) VALUES (${memberE}::uuid, 'free', '지울 글', '본문') RETURNING id`;
  await sql`INSERT INTO community_comment (post_id, author_id, body) VALUES (${post.id}, ${memberE}::uuid, '지울 댓글')`;
  await member.withdrawMember(tokenE, { deleteContent: true }, T0);
  const left = await sql<{ n: number }[]>`
    SELECT (SELECT count(*) FROM community_post WHERE author_id = ${memberE}::uuid AND status <> 'deleted')
         + (SELECT count(*) FROM community_comment WHERE author_id = ${memberE}::uuid AND status <> 'deleted') AS n`;
  const [eDeleted] = await sql<{ deleted_at: Date | null }[]>`SELECT deleted_at FROM community_post WHERE id = ${ePost.id}`;
  check("'내 글·댓글도 지우기' 를 고르면 같은 트랜잭션에서 삭제한다(파기 기준 시각이 남는다)",
    Number(left[0].n) === 0 && eDeleted.deleted_at?.getTime() === T0.getTime());
}
