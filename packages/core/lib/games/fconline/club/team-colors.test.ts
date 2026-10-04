import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseTeamColors } from "./team-colors.ts";
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8");
test("official country flag, name, count and timestamp", () => {
  const r = parseTeamColors(fixture("rank-france"), "호날두", 1809854163);
  assert.equal(r.colors[0].kind, "country"); assert.equal(r.colors[0].name, "프랑스");
  assert.equal(r.colors[0].players, 11); assert.match(r.sourceAt, /\+09:00$/);
});
test("matching member number and nickname is required", () => {
  assert.throws(() => parseTeamColors(fixture("rank-france"), "호날두", 1));
  assert.throws(() => parseTeamColors(fixture("rank-france"), "다른구단주", 1809854163));
  assert.throws(() => parseTeamColors("maintenance", "호날두", 1809854163));
});
test("club badges qualify but special/enhancement images do not", () => {
  const html = fixture("rank-france");
  const club = html.replaceAll("countries/largeflags/f_18.png", "crests/light/medium/l11.png").replaceAll("프랑스", "맨체스터 유나이티드");
  assert.equal(parseTeamColors(club, "호날두", 1809854163).colors[0].kind, "club");
  assert.deepEqual(parseTeamColors(html.replaceAll("countries/largeflags/f_18.png", "teamcolor/special/123.png"), "호날두", 1809854163).colors, []);
});
test("empty official ranking clears old colors; malformed markup does not", () => {
  assert.deepEqual(parseTeamColors(fixture("rank-empty"), "저창FC", 1977710213).colors, []);
  assert.throws(() => parseTeamColors(fixture("rank-france").replace('class="inner"', 'class="changed"'), "호날두", 1809854163));
});

test("real club ranking and mixed chemistry retain only country/club images", () => {
  const top = fixture("rank-top");
  const owner = /class="name profile_pointer" data-sn="(\d+)">([^<]+)<\/span>/.exec(top)!;
  assert.equal(parseTeamColors(top, owner[2], Number(owner[1])).colors[0].name, "FC 포르투");
  const france = fixture("rank-france");
  const mixed = france.replace('<span class="ico_rank">\n                                            <img', '<span class="ico_rank"><img src="https://fco.dn.nexoncdn.co.kr/live/externalAssets/common/teamcolor/special/123.png"><img')
    .replace('<span class="inner">\n프랑스', '<span class="inner">금빛 물결 <small>(11명)</small></span><span class="inner">\n프랑스');
  assert.deepEqual(parseTeamColors(mixed, "호날두", 1809854163).colors.map(c => c.name), ["프랑스"]);
});

test("profile affiliation provides France and excludes enhanced/season chemistry", async () => {
  const { parseSquadTeamColors } = await import('./team-colors.ts');
  const raw = readFileSync(new URL('./fixtures/squad-team-colors.json', import.meta.url), 'utf8');
  const colors = parseSquadTeamColors(raw);
  assert.deepEqual(colors.map(c => [c.name, c.players, c.kind]), [['프랑스', 11, 'country']]);
  assert.deepEqual(parseSquadTeamColors('{"totalTeamColor":{"affiliation":{}}}'), []);
  assert.throws(() => parseSquadTeamColors('{}'));
});
