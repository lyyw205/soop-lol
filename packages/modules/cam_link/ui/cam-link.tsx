"use client";
import { useEffect, useRef, useState } from "react";
import { inviteText, seatName, type CamOptions, type CamQuality } from "./links.ts";
import { loadRoom, NAME_MAX, newRoom, newSeat, ROOM_MAX, ROOM_MIN, saveRoom, type SavedRoom } from "./rooms.ts";

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
  const [resumed, setResumed] = useState(false);
  // 이름 칸을 벗어나며 저장한 직후 같은 클릭의 복사가 옛 방으로 덮어쓰지 않게, 최신 방은 ref 로 읽는다.
  const latest = useRef<SavedRoom | null>(null);
  useEffect(() => {
    const saved = loadRoom();
    latest.current = saved ?? newRoom();
    setCurrent(latest.current);
    setResumed(!!saved);
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
    latest.current = newRoom();
    setCurrent(latest.current);
    setResumed(false);
  }

  if (!current) return <div className="cam"><Head /></div>;
  const { room, seats, options } = current;
  const text = inviteText(room, seats, options);
  // 명단 고정이라 사람·설정이 바뀌면 이미 보낸 링크가 낡는다.
  const stale = !!current.sent && current.sent !== text;
  const setOption = <K extends keyof CamOptions>(key: K, value: CamOptions[K]) => commit({ options: { ...options, [key]: value } });

  return <div className="cam">
    <Head />

    <section className="cam-panel" aria-label="참가자">
      <div className="cam-panel-head">
        <h2>참가자 <small>{seats.length}명</small></h2>
        {resumed ? <span className="cam-pill" title="링크가 그대로라 방송 도구에 넣어 둔 보기 창을 다시 넣지 않아도 됩니다">지난 방 그대로</span> : null}
      </div>
      <ol className="cam-seats">
        {seats.map((seat, i) => <li key={seat.id} className="cam-seat">
          <span className="cam-step">{i + 1}</span>
          <NameInput value={seat.name} placeholder={i === 0 ? "내 이름 (방장)" : `참가자 ${i + 1} 이름`}
            onCommit={(name) => commit({ seats: latest.current!.seats.map((s) => s.id === seat.id ? { ...s, name } : s) })} />
          {seats.length > ROOM_MIN && i > 0
            ? <button type="button" className="cam-remove" aria-label={`${seatName(seat, i)} 빼기`}
              onClick={() => commit({ seats: latest.current!.seats.filter((s) => s.id !== seat.id) })}>×</button>
            : <span className="cam-remove-gap" />}
        </li>)}
      </ol>
      {seats.length < ROOM_MAX
        ? <button type="button" className="cam-add" onClick={() => commit({ seats: [...latest.current!.seats, newSeat()] })}>+ 참가자 추가</button>
        : null}
    </section>

    <section className="cam-go" aria-label="초대">
      {stale ? <p className="cam-warn" role="status">참가자나 설정이 바뀌었습니다. 초대 문구를 다시 복사해서 보내세요 — 다시 보내야 새 명단이 모두의 화면에 뜹니다.</p> : null}
      <CopyButton text={text} latest={() => { const r = latest.current!; return inviteText(r.room, r.seats, r.options); }}
        onCopied={(sent) => commit({ sent })} />
    </section>

    <section className="cam-panel cam-settings" aria-label="설정">
      <h2>설정</h2>
      <div className="cam-option">
        <span className="cam-option-label">화질<small>보내는 캠의 최대 해상도</small></span>
        <div className="cam-segment" role="radiogroup" aria-label="화질">
          {QUALITIES.map((q) => <button key={q.value} type="button" role="radio" aria-checked={options.quality === q.value}
            onClick={() => setOption("quality", q.value)}>{q.label}</button>)}
        </div>
      </div>
      <Toggle label="소리 받기" note="켜면 상대 목소리도 같이 나옵니다 — 디스코드로 통화 중이면 두 번 나가니 꺼 두세요"
        checked={options.audio} onChange={(v) => setOption("audio", v)} />
      <Toggle label="지연 최소화" note="재생 대기를 0으로 — 영상이 끊기면 끄세요"
        checked={options.lowLatency} onChange={(v) => setOption("lowLatency", v)} />
    </section>

    <section className="cam-panel cam-restart" aria-label="새 방">
      <div>
        <h2>새 방 만들기</h2>
        <p className="cam-hint">링크가 방송·공개 채널에 노출됐거나, 전혀 다른 멤버로 합방할 때 씁니다. 이전 링크로는 새 방에 들어올 수 없습니다.</p>
      </div>
      <button type="button" className="cam-secondary" onClick={restart}>새 방 만들기</button>
    </section>

    <section className="cam-panel cam-guide" aria-label="방장 사용법">
      <h2>방장 사용법</h2>
      <ol className="cam-steps">
        <li>참가자 이름을 적습니다. 1번이 나(방장)입니다.</li>
        <li><b>초대 문구 복사</b> → 참가자만 있는 디스코드 채널이나 DM에 붙여 넣습니다.</li>
        <li>나도 문구의 내 이름 아래 ①을 열어 시작을 누르고, ②를 방송 도구에서 캡처합니다.</li>
        <li>다음 합방엔 이 페이지를 다시 열면 지난 방 그대로입니다. 같은 멤버면 다시 보낼 필요가 없습니다.</li>
        <li>참가자를 바꾸거나 설정을 바꾸면 초대 문구를 다시 보냅니다.</li>
      </ol>
      <p className="cam-hint">영상은 이 사이트를 거치지 않고 <a href="https://vdo.ninja" target="_blank" rel="noreferrer">VDO.Ninja</a>로 참가자끼리 직접 오갑니다.</p>
    </section>
  </div>;
}

function Head() {
  return <header className="cam-head">
    <h1>실시간 캠공유</h1>
    <p>참가자 이름을 적고 초대 문구를 보내면 끝. 방송 화면을 따는 것보다 훨씬 빠른 <strong>실시간</strong> 캠 연결입니다.</p>
  </header>;
}

function NameInput({ value, placeholder, onCommit }: { value: string; placeholder: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <input className="cam-name" value={draft} placeholder={placeholder} maxLength={NAME_MAX} aria-label={placeholder}
    onChange={(e) => setDraft(e.target.value)} onBlur={() => draft !== value && onCommit(draft)}
    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

/** text 는 "복사됨" 표시를 언제 지울지, latest 는 실제로 복사할 글 — 이름 칸을 막 벗어난 클릭에서도 새 이름이 들어간다. */
function CopyButton({ text, latest, onCopied }: { text: string; latest: () => string; onCopied: (sent: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);
  async function copy() {
    const value = latest();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      window.prompt("복사해서 쓰세요", value);
    }
    onCopied(value);
  }
  return <button type="button" className="cam-primary" onClick={copy}>{copied ? "복사됨 — 단톡방·디스코드에 붙여 넣으세요" : "초대 문구 복사"}</button>;
}

function Toggle({ label, note, checked, onChange }: { label: string; note: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="cam-option cam-toggle">
    <span className="cam-option-label">{label}<small>{note}</small></span>
    <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
  </label>;
}
