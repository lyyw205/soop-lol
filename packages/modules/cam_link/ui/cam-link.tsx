"use client";
import { Send, LockKeyhole, CircleHelp } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { inviteText, namedSeats, seatName, type CamOptions, type CamQuality } from "./links.ts";
import { loadRoom, NAME_MAX, newRoom, newSeat, ROOM_MIN, saveRoom, type SavedRoom } from "./rooms.ts";

const QUALITIES: { value: CamQuality; label: string }[] = [
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "360", label: "360p" },
];

/**
 * 방장 한 사람이 쓰는 화면: 참가자 이름 → 초대 문구 복사. 참가자 1 이 방장(나)이다.
 * 방장도 다른 사람과 똑같이 초대 문구의 자기 링크 두 개를 쓴다 — 방장용 링크는 따로 없다.
 */
export function CamLink() {
  // 첫 렌더(서버)에서는 비워 두고 브라우저에서 정한다 — 지난 방은 이 브라우저에만 있다.
  const [current, setCurrent] = useState<SavedRoom | null>(null);
  // 이름 칸을 벗어나며 저장한 직후 같은 클릭의 복사가 옛 방으로 덮어쓰지 않게, 최신 방은 ref 로 읽는다.
  const latest = useRef<SavedRoom | null>(null);
  useEffect(() => {
    const saved = loadRoom();
    latest.current = saved ?? newRoom();
    setCurrent(latest.current);
  }, []);

  /** 손댄 방만 기억한다 — 열어만 본 새 방은 남기지 않는다. */
  function commit(patch: Partial<SavedRoom> = {}) {
    if (!latest.current) return;
    latest.current = { ...latest.current, ...patch };
    setCurrent(latest.current);
    saveRoom(latest.current);
  }
  function restart() {
    if (latest.current?.sent && !window.confirm("새 방을 만들면 지금 초대 문구의 링크로는 새 방에 들어올 수 없습니다. 새 초대 문구를 다시 보내야 합니다. 만들까요?")) return;
    // 새 방은 사용자가 고른 것이니 바로 기억한다 — 안 그러면 새로고침에 이전 방이 되살아난다.
    latest.current = newRoom();
    setCurrent(latest.current);
    saveRoom(latest.current);
  }

  if (!current) return <div className="cam cam-studio"><Head /></div>;
  const { room, seats, options } = current;
  const participantCount = namedSeats(seats).length;
  const text = inviteText(room, seats, options);
  // 명단 고정이라 사람·설정이 바뀌면 이미 보낸 링크가 낡는다.
  const stale = !!current.sent && current.sent !== text;
  const setOption = <K extends keyof CamOptions>(key: K, value: CamOptions[K]) => commit({ options: { ...options, [key]: value } });

  return <div className="cam cam-studio">
    <Head />
    <div className="cam-workspace">
      <section className="cam-roster" aria-labelledby="cam-roster-title">
        <div className="cam-section-head">
          <div><span className="cam-eyebrow">THE LINEUP / 참가자 명단</span><h2 id="cam-roster-title">함께할 멤버 <span>{participantCount}<small>명</small></span></h2></div>
          <button type="button" className="cam-restart" onClick={restart}><Icon name="plus" />새 방 만들기</button>
        </div>
        <p className="cam-roster-note">이름을 입력한 멤버만 초대 링크가 생성됩니다. 빈칸은 그대로 두세요.</p>
        <ol className="cam-seats">
          {seats.map((seat, i) => <li key={seat.id} className={`cam-seat${i === 0 ? " cam-seat-host" : ""}`}>
            <div className="cam-seat-top">
              <label htmlFor={`cam-name-${seat.id}`} className="cam-seat-label">{i === 0 ? "나 · 방장" : `참가자 ${i + 1}`}</label>
              {seats.length > ROOM_MIN && i > 0
                ? <button type="button" className="cam-remove" aria-label={`${seatName(seat, i)} 빼기`}
                  onClick={() => commit({ seats: latest.current!.seats.filter((s) => s.id !== seat.id) })}><Icon name="close" /></button>
                : <span className="cam-seat-mark" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>}
            </div>
            <NameInput id={`cam-name-${seat.id}`} value={seat.name} placeholder={i === 0 ? "내 이름 입력" : "이름 입력"}
              onCommit={(name) => commit({ seats: latest.current!.seats.map((s) => s.id === seat.id ? { ...s, name } : s) })} />
          </li>)}
          <li className="cam-add-seat"><button type="button" className="cam-add"
            onClick={() => commit({ seats: [...latest.current!.seats, newSeat()] })}>
            <Icon name="plus" /><span>참가자 추가</span>
          </button></li>
        </ol>

      </section>

      <div className="cam-side">
      <aside className="cam-invite" aria-labelledby="cam-invite-title">
        <span className="cam-eyebrow">YOUR INVITATION / 초대장</span>
        <div className="cam-invite-symbol" aria-hidden="true"><Icon name="link" /></div>
        <h2 id="cam-invite-title">링크 두 개로 캠 연결</h2>
        <dl className="cam-invite-description cam-invite-instructions">
          <div><dt><Send size={17} strokeWidth={1.7} aria-hidden="true" /><span className="cam-instruction-label">공유</span></dt><dd>멤버 이름을 입력한 뒤, 초대 문구를 복사해 참가자들의 디스코드·단톡방에 보내세요.</dd></div>
          <div><dt><LockKeyhole size={17} strokeWidth={1.7} aria-hidden="true" /><span className="cam-instruction-label">주의</span></dt><dd>링크가 다른 사람에게 <strong>노출되지 않게</strong> 해 주세요.</dd></div>
          <div><dt><CircleHelp size={17} strokeWidth={1.7} aria-hidden="true" /><span className="cam-instruction-label">도움말</span></dt><dd>연결 방법은 하단 <a href="#cam-guide-title">캠 연결 방법 안내</a>에서 확인하세요.</dd></div>
        </dl>
        <div className="cam-invite-summary"><span>이번 초대</span><strong>{participantCount}명 <span>· {participantCount * 2}개 링크</span></strong></div>
        {stale ? <p className="cam-warn" role="status">명단이나 설정이 바뀌었어요. 초대 문구를 다시 복사해 보내 주세요.</p> : null}
        <CopyButton text={text} latest={() => { const r = latest.current!; return inviteText(r.room, r.seats, r.options); }}
          onCopied={(sent) => commit({ sent })} />
      </aside>
        <details className="cam-settings cam-settings-card">
          <summary><span><Icon name="settings" />연결 설정</span><span className="cam-setting-summary">{options.quality}p · 소리 {options.audio ? "켬" : "끔"}<Icon name="chevron" /></span></summary>
          <div className="cam-settings-body">
            <fieldset className="cam-quality" aria-describedby="cam-quality-hint">
              <legend>보내는 화질</legend>
              <div className="cam-segment">
                {QUALITIES.map((q) => <label key={q.value}><input type="radio" name="cam-quality" value={q.value}
                  checked={options.quality === q.value} onChange={() => setOption("quality", q.value)} /><span>{q.label}</span></label>)}
              </div>
              <p id="cam-quality-hint" className="cam-quality-hint">기본은 1080p. 영상이 끊기면 화질을 낮춰 주세요.</p>
            </fieldset>
            <Toggle label="상대 소리 받기" note="디스코드로 통화한다면 꺼 두세요."
              checked={options.audio} onChange={(v) => setOption("audio", v)} />
            <Toggle label="지연 최소화" note="영상이 끊기면 꺼 보세요."
              checked={options.lowLatency} onChange={(v) => setOption("lowLatency", v)} />
          </div>
        </details>
      </div>
    </div>

    <section className="cam-manual" aria-labelledby="cam-guide-title">
      <header className="cam-manual-heading">
        <h2 id="cam-guide-title">캠 연결 방법 안내</h2>
        <p>방장도 참가자도 초대 문구에서 자기 이름 아래 링크를 사용합니다.</p>
      </header>
      <div className="cam-manual-flow">
        <GuideStep number="01" title="내 캠 켜기" action="추가 설정 보기" icon="camera"
          description={<>‘내 캠 켜기’ 링크를 열고 카메라·마이크 권한을 허용한 뒤, 미리보기에 내 캠이 나오면 <b>START</b>를 누르세요.</>}
          note="이 창을 켜 두면 다른 멤버가 ‘다른 사람 캠 보기’ 링크에서 내 캠을 볼 수 있습니다.">
          <p className="cam-device-intro">기본 장치로 캠이 잘 나오면 변경하지 않아도 됩니다. 다른 카메라나 소리 장치를 쓰고 싶을 때 아래 항목을 조절하세요.</p>
          <dl className="cam-device-guide">
            <div><dt>Video Source <span>보낼 카메라</span></dt><dd>사용할 웹캠이나 캡처 장치를 고르세요. OBS 화면을 보내려면 OBS에서 가상 카메라를 먼저 켠 뒤 <b>OBS Virtual Camera</b>를 선택합니다.</dd></div>
            <div><dt>Audio Source(s) <span>보낼 마이크 소리</span></dt><dd>디스코드로 통화한다면 <b>No Audio</b>를 선택하세요. 캠과 함께 목소리도 보내려면 사용할 마이크를 고릅니다.</dd></div>
            <div><dt>Audio Output Destination <span>내가 들을 소리의 출력 장치</span></dt><dd>소리를 들을 헤드셋이나 스피커를 고르세요. 평소 쓰는 장치가 기본값이라면 그대로 두면 됩니다. 상대에게 보내는 소리를 정하는 항목은 아닙니다.</dd></div>
          </dl>
        </GuideStep>
        <GuideStep number="02" title="다른 사람 캠 보기" action="자세히 보기" icon="screen"
          description={<>‘내 캠 켜기’ 창을 켜 둔 상태에서, 내 이름 아래 <b>다른 사람 캠 보기</b> 링크를 새 창으로 여세요.</>}>
          <ol className="cam-watch-steps">
            <li><h4>다른 멤버의 캠 확인</h4><p>나를 제외한 멤버들의 캠이 한 화면에 모입니다. 화면이 비어 있다면 상대도 ‘내 캠 켜기’ 링크에서 START를 눌렀는지 확인하세요.</p></li>
            <li><h4>방송 화면에 넣기</h4><p>OBS 등 방송 도구에서 ‘다른 사람 캠 보기’ 창을 캡처하세요. 주소창과 브라우저 메뉴가 나오지 않도록 영상 부분만 잘라 배치하면 됩니다.</p></li>
            <li><h4>소리가 필요한 경우</h4><p>기본 설정은 소리는 받지 않고 영상만 받습니다. 목소리도 받으려면 방장이 '상대 소리 받기' 설정을 켜고 새로운 초대문구를 다시 보내야합니다. 참가자도 '내 캠 켜기' 링크에서 마이크를 선택해주세요.</p></li>
          </ol>
        </GuideStep>
      </div>
    </section>
  </div>;
}

function GuideStep({ number, title, action, icon, description, note, children }: {
  number: string; title: string; action: string; icon: "camera" | "screen";
  description: ReactNode; note?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <section className="cam-manual-step" aria-labelledby={`${id}-title`}>
    <div className="cam-manual-rail" aria-hidden="true"><span>{number}</span></div>
    <div className="cam-manual-body">
      <h3 id={`${id}-title`}><Icon name={icon} />{title}</h3>
      <p className="cam-manual-description">{description}</p>
      {note ? <p className="cam-manual-note">{note}</p> : null}
      <button className="cam-manual-disclosure" type="button" aria-expanded={open} aria-controls={`${id}-detail`}
        onClick={() => setOpen(!open)}>{open ? "접기" : action}<Icon name="chevron" /></button>
      <div id={`${id}-detail`} className="cam-manual-detail" hidden={!open}>{children}</div>
    </div>
  </section>;
}

function Head() {
  return <header className="cam-head">
    <div className="cam-kicker"><Icon name="camera" /><span>CAM ROOM</span><span className="cam-kicker-line" />실시간 캠공유</div>
    <div className="cam-heading-copy"><h1>딜레이를 줄인 실시간 캠 공유</h1><p>같은 장면에 같은 타이밍으로 반응하고, 서로의 리액션을 실시간으로 확인하세요.</p><p className="cam-service-note">VDO.Ninja를 이용한 캠 공유 서비스입니다. 참가자별 연결 링크와 설정을 간편하게 준비해 드립니다.</p></div>
  </header>;
}

function Icon({ name }: { name: "camera" | "plus" | "close" | "check" | "settings" | "chevron" | "link" | "lock" | "screen" | "repeat" | "copy" }) {
  const paths = {
    camera: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="m15 10 6-3v10l-6-3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    check: <path d="m5 12 4 4L19 6" />,
    settings: <><path d="M4 7h6m4 0h6M4 17h10m4 0h2" /><circle cx="12" cy="7" r="2" /><circle cx="16" cy="17" r="2" /></>,
    chevron: <path d="m6 9 6 6 6-6" />,
    link: <><path d="m10 13 4-4m-5 6-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
    screen: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8m-4-4v4" /></>,
    repeat: <><path d="M20 7H8a5 5 0 0 0-5 5m1 5h12a5 5 0 0 0 5-5M16 3l4 4-4 4M8 13l-4 4 4 4" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function NameInput({ id, value, placeholder, onCommit }: { id: string; value: string; placeholder: string; onCommit: (v: string) => void }) {
  return <input id={id} autoComplete="off" className="cam-name" value={value} placeholder={placeholder} maxLength={NAME_MAX} aria-label={placeholder}
    onChange={(e) => onCommit(e.target.value)}
    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

/** text 는 "복사됨" 표시를 언제 지울지, latest 는 실제로 복사할 글 — 이름 칸을 막 벗어난 클릭에서도 새 이름이 들어간다. */
function CopyButton({ text, latest, onCopied }: { text: string; latest: () => string; onCopied: (sent: string) => void }) {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const copied = copiedText === text;
  async function copy() {
    const value = latest();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (window.prompt("복사해서 쓰세요", value) === null) return;
    }
    setCopiedText(value);
    onCopied(value);
  }
  return <button type="button" className="cam-primary" disabled={!text} onClick={copy}><Icon name={copied ? "check" : "copy"} /><span aria-live="polite">{copied ? "복사 완료! 붙여 넣어 주세요" : text ? "초대 문구 복사" : "멤버 이름을 입력해 주세요"}</span></button>;
}

function Toggle({ label, note, checked, onChange }: { label: string; note: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="cam-option cam-toggle">
    <span className="cam-option-label">{label}<small>{note}</small></span>
    <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </label>;
}
