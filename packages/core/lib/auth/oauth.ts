/**
 * 소셜 로그인(OpenID Connect) — docs/COMMUNITY-PLAN.md §2 "로그인".
 *
 * ★ 프로토콜은 openid-client 가 한다(PKCE·state·nonce·코드 교환·ID 토큰 검사). 직접 구현하지 않는다.
 *   ID 토큰은 토큰 엔드포인트에서 TLS 로 직접 받으므로 서명 대신 TLS 서버 검증을 쓴다(OIDC 규격 — openid-client 기본값).
 *   발급자·대상 앱·만료·nonce 는 검사한다.
 * ★ 회원·세션은 우리 것이다. 여기는 "이 사람은 카카오의 sub X 다" 까지만 답한다(member.ts 가 회원을 정한다).
 * ★ Next 를 모른다 — 쿠키 값과 주소를 인자로 받는다. 그래서 검증(verify:db)이 가짜 제공자로 같은 함수를 부른다
 *   (Configuration 에 가짜 메타데이터 + customFetch — "가짜는 HTTP 경계뿐").
 */

import * as client from "openid-client";

export type Provider = "kakao" | "google";
export const PROVIDERS: readonly Provider[] = ["kakao", "google"];
export const PROVIDER_LABEL: Record<Provider, string> = { kakao: "카카오", google: "구글" };
export const isProvider = (v: string): v is Provider => (PROVIDERS as readonly string[]).includes(v);

/** 로그인 상태 쿠키. 콜백 경로에만 보낸다. */
export const LOGIN_STATE_COOKIE = "soop_login";
export const LOGIN_STATE_TTL_MS = 10 * 60_000;

const DEFAULT_ISSUER: Record<Provider, string> = { kakao: "https://kauth.kakao.com", google: "https://accounts.google.com" };
const ENV_PREFIX: Record<Provider, string> = { kakao: "KAKAO", google: "GOOGLE" };

interface ProviderSetup { issuer: URL; clientId: string; clientSecret: string | null }

function setupFromEnv(provider: Provider): ProviderSetup | null {
  const prefix = ENV_PREFIX[provider];
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  if (!clientId) return null;
  return {
    // 기본은 실제 제공자. 로컬 검증에서만 가짜 제공자 주소로 바꾼다.
    issuer: new URL(process.env[`OAUTH_${prefix}_ISSUER`] ?? DEFAULT_ISSUER[provider]),
    clientId,
    clientSecret: process.env[`${prefix}_CLIENT_SECRET`] || null,
  };
}

/** 설정된(client id 가 있는) 제공자만. 설정이 없으면 그 로그인 버튼을 그리지 않는다(fail-closed). */
export const enabledProviders = (): Provider[] => PROVIDERS.filter((p) => setupFromEnv(p) !== null);

const isLocal = (url: URL) => url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");

const configs = new Map<Provider, Promise<client.Configuration>>();

/** 제공자 설정(OIDC discovery). 프로세스 안에서 한 번만 받는다. 실패하면 다음 요청에서 다시 받는다. */
export function providerConfig(provider: Provider): Promise<client.Configuration> {
  const cached = configs.get(provider);
  if (cached) return cached;
  const setup = setupFromEnv(provider);
  if (!setup) return Promise.reject(new Error(`${PROVIDER_LABEL[provider]} 로그인이 설정되지 않았습니다`));
  const pending = client.discovery(
    setup.issuer, setup.clientId, undefined,
    setup.clientSecret ? client.ClientSecretPost(setup.clientSecret) : client.None(),
    // http 는 로컬 가짜 제공자에게만 허용한다. 실제 제공자는 언제나 https 다.
    { execute: isLocal(setup.issuer) ? [client.allowInsecureRequests] : [] },
  );
  configs.set(provider, pending);
  pending.catch(() => configs.delete(provider));
  return pending;
}

// ── 로그인 상태 ──────────────────────────────────────────────────────

/** 인가 요청을 보낼 때 만들어 쿠키에 담고, 콜백에서 한 번 쓰고 지운다. */
export interface LoginState {
  /** 제공자 — 다른 제공자의 콜백으로 오면 거부한다(제공자 혼동). */
  p: Provider;
  state: string;
  nonce: string;
  verifier: string;
  /** 로그인 뒤 돌아갈 내부 주소 */
  next: string;
  /** 만든 시각(ms) */
  t: number;
}

export const encodeLoginState = (s: LoginState): string => Buffer.from(JSON.stringify(s), "utf8").toString("base64url");

export function decodeLoginState(value: string | null | undefined): LoginState | null {
  if (!value) return null;
  try {
    const s = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LoginState>;
    if (typeof s.p !== "string" || !isProvider(s.p)) return null;
    if ([s.state, s.nonce, s.verifier, s.next].some((x) => typeof x !== "string") || typeof s.t !== "number") return null;
    return s as LoginState;
  } catch {
    return null;
  }
}

/**
 * 로그인 뒤 돌아갈 주소. **내부 주소만** 받는다 — 열린 리다이렉트를 막는다(관리자의 adminReturn 과 같은 검사).
 */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  try {
    const url = new URL(value, "https://site.invalid");
    return url.origin === "https://site.invalid" ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/** 인가 요청 주소와 쿠키에 담을 상태. */
export async function startLogin(config: client.Configuration, provider: Provider, redirectUri: string, next: string, now = Date.now()) {
  const verifier = client.randomPKCECodeVerifier();
  const state: LoginState = { p: provider, state: client.randomState(), nonce: client.randomNonce(), verifier, next: safeNextPath(next), t: now };
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state: state.state,
    nonce: state.nonce,
  });
  return { url, state };
}

/**
 * 콜백 처리. 실패하면 LoginError(또는 openid-client 의 오류)를 던진다.
 *
 * @param currentUrl 콜백 주소 + 쿼리. **등록한 redirect_uri 와 같은 주소여야 한다** — 토큰 요청의 redirect_uri 를
 *   여기서 쿼리를 뺀 값으로 쓴다. 그래서 호출자는 요청 주소를 그대로 믿지 말고 사이트 주소(SITE_ORIGIN) 기준으로 만들어 넘긴다.
 */
export async function finishLogin(
  config: client.Configuration, provider: Provider, stateCookie: string | null | undefined, currentUrl: URL, now = Date.now(),
): Promise<{ subject: string; next: string }> {
  const state = decodeLoginState(stateCookie);
  if (!state) throw new LoginError("로그인 상태가 없습니다 — 만료됐거나 이미 쓴 콜백입니다");
  if (state.p !== provider) throw new LoginError("다른 제공자의 로그인 응답입니다");
  if (now - state.t > LOGIN_STATE_TTL_MS || now < state.t) throw new LoginError("로그인 시간이 지났습니다");
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: state.verifier,
    expectedState: state.state,
    expectedNonce: state.nonce,
    idTokenExpected: true,
  });
  const subject = tokens.claims()?.sub;
  if (!subject) throw new LoginError("ID 토큰에 사용자 식별값이 없습니다");
  return { subject, next: state.next };
}
