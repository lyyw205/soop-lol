"use client";

export function Avatar({ name, src, channelId }: { name: string; src?: string | null; channelId?: string | null }) {
  const image = src ?? (channelId ? `https://stimg.sooplive.co.kr/LOGO/${channelId.slice(0, 2)}/${channelId}/${channelId}.jpg` : null);
  return <span className="arena-avatar" aria-label={name}>
    <span aria-hidden="true">{name.slice(0, 2)}</span>
    {image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.hidden = true; }} />}
  </span>;
}
