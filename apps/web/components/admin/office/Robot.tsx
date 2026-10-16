import type { Mood } from "./brief";

/** Animate inner groups only; the outer group's translation belongs to the isometric scene. */
export function Robot({ mood, color, variant = 0 }: { mood: Mood; color: string; variant?: number }) {
  return <g className={`of-bot is-${mood}`} style={{ animationDelay: `${variant * -.7}s` }} aria-hidden="true">
    <ellipse cy="2" rx="12" ry="4" fill="#030a11" opacity=".65" />
    <g className="of-robot-body">
      <path d="M-5 -3v-5M5 -3v-5" stroke="#6c8099" strokeWidth="5" strokeLinecap="round" />
      <rect x="-8" y="-16" width="16" height="11" rx="4" fill="#97b6c9" stroke="#d9e8ef" strokeWidth=".6" />
      <path d="M-3 -11h6" stroke={color} strokeWidth="2" />
      <g className="of-robot-head"><rect x="-11" y="-30" width="22" height="17" rx="7" fill="#d3e3ec" stroke="#8fadc2" />
        <rect x="-9" y="-26" width="18" height="9" rx="4" fill="#152a3e" />
        <g className="of-robot-eyes"><path d={mood === "paused" ? "M-6 -21h4m4 0h4" : mood === "help" ? "M-6 -24l4 2-4 2m12-4-4 2 4 2" : "M-5 -22h2m6 0h2"} stroke={color} strokeWidth="2" strokeLinecap="round" fill="none" /></g>
        <circle cy="-34" r="2" fill={color} /><path d="M0 -31v-3" stroke={color} />
      </g>
      <path className="of-robot-arm left" d="M-9 -13l-6 7 4 2" stroke="#adc9db" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path className="of-robot-arm right" d="M9 -13l6 7-4 2" stroke="#adc9db" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      {mood === "working" && <g className="of-key-sparks" fill={color}><circle cx="-15" cy="-10" r="1.4" /><circle cx="15" cy="-8" r="1.4" /><path d="M-18 -6h4m28-7h4" stroke={color} /></g>}
    </g>
    {mood === "help" && <g className="of-robot-callout"><path d="M12-53h17q4 0 4 4v11q0 4-4 4h-9l-6 5v-5h-2q-4 0-4-4v-11q0-4 4-4" fill="#fbb788" /><text x="21" y="-39" textAnchor="middle" fill="#3e241c" fontSize="13" fontWeight="800">!</text></g>}
    {mood === "paused" && <g className="of-robot-sleep" fill="#adc4de" fontSize="10" fontWeight="700"><text x="14" y="-32">z</text><text x="22" y="-43" fontSize="8">z</text></g>}
    {mood === "unknown" && <text x="15" y="-36" fill="#a3b7cc" fontSize="13">?</text>}
    {mood === "idle" && <g className="of-robot-coffee"><path d="M12-12h8v8h-8zm8 1q6 0 2 5h-2" fill="#d2bba0" stroke="#f1d5b5" strokeWidth="1" /><path className="of-coffee-steam" d="M14-15q-3-3 0-5m4 4q3-3 0-5" fill="none" stroke="#b7d8e3" strokeWidth=".7" /></g>}
  </g>;
}
export function RobotPortrait({ mood, color }: { mood: Mood; color: string }) {
  return <svg className="of-robot-portrait" viewBox="-28 -58 67 70" aria-hidden="true"><Robot mood={mood} color={color} /></svg>;
}
