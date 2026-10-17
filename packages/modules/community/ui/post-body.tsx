import { postBodyBlocks } from "./media.ts";
import { PlainText } from "./text.tsx";

/** 작성 미리보기와 공개 본문은 같은 렌더러를 사용한다. 댓글/검색 요약에는 적용하지 않는다. */
export function PostBody({ text }: { text: string }) {
  return <div className="cm-rich-body">{postBodyBlocks(text).map((block, i) => block.kind === "text"
    ? <div className="cm-text" key={`text-${i}`}><PlainText text={block.text} /></div>
    : <figure className={`cm-video${block.video.portrait ? " cm-video-portrait" : ""}`} key={`${i}-${block.video.src}`}>
      <iframe src={block.video.src} title={`${block.video.provider} 영상 ${i + 1}`} loading="lazy"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="fullscreen; encrypted-media; picture-in-picture" allowFullScreen />
      <figcaption><span>{block.video.provider} · 재생되지 않으면</span> <a href={block.video.href} target="_blank" rel="nofollow ugc noopener noreferrer">원본에서 보기 ↗</a></figcaption>
    </figure>)}</div>;
}
