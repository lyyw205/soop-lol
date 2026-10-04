/** Shared by URL parsing and the picker so both enforce the same limit. */
export const PLAYER_COLORS = [
  "#d95926", "#199e70", "#c98500", "#d55181", "#65a8ed",
  "#a98aeb", "#42c7c7", "#d3ce72", "#ef987e", "#82bc71",
  "#e8ac56", "#ee89ba", "#879ee8", "#cb90df", "#7fcec0",
  "#b4bd89", "#c59170", "#73b4a0", "#b6adcc", "#c5cdd7",
] as const;
export const MAX_PLAYERS = PLAYER_COLORS.length;
