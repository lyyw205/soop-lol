import ts from 'typescript';

/** 알려진 분기를 AST로 검사한다. 표시용 색상 분기나 순위 메달은 금지하지 않는다. */
export function consistencyViolations(file: string, source: string): string[] {
  if (/\.(test|selftest)\./.test(file)) return [];
  const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const problems: string[] = [];
  const calls = new Set<string>();
  const imported = new Set<string>();
  const walk = (node: ts.Node) => {
    if(ts.isImportSpecifier(node)) imported.add(node.name.text);
    if(ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text);
    if(ts.isIdentifier(node) && ['counts_toward_titles','riotGames','linkFcoMatchToEvent'].includes(node.text)) problems.push(`폐기한 실행 경로: ${node.text}`);
    if(ts.isFunctionDeclaration(node) && node.name && ['seriesOutcome','pairSetOutcome','foldSeries','formatLabel','formatChipLabel','classifyTeamStage','pickRepresentative','resolveClubState'].includes(node.name.text)
      && !file.startsWith('packages/core/')) problems.push(`공통 규칙을 화면에서 재정의: ${node.name.text}`);
    if(ts.isObjectLiteralExpression(node)) {
      const keys=node.properties.flatMap(p => p.name ? [p.name.getText(ast).replace(/["']/g,'')] : []);
      // 진행 방식 이름표는 core 의 format.ts 하나다(0089). 화면이 ck·tournament·concept 표를 다시 만들면 어긋난다.
      if(keys.includes('ck') && keys.includes('tournament') && (keys.includes('concept') || keys.includes('showmatch')) && !file.startsWith('packages/core/')) problems.push('화면의 진행 방식 이름표');
    }
    ts.forEachChild(node,walk);
  };
  walk(ast);
  const needs: Record<string,string[]> = {
    'apps/web/app/fc/page.tsx':['formatLabel','change7d'],
    'packages/modules/fc_club_value/ui/page.tsx':['change7d'],
    'packages/modules/tournaments/ui/tournament-detail.tsx':['classifyTeamStage'],
    'apps/web/components/fco-squad-usage.tsx':['fcoPlayerAppearance'],
    'packages/modules/fc_tournaments/ui/model.ts':['fcoPlayerAppearance'],
    'packages/ui/fc/fco-records.tsx':['fcoPlayerAppearance'],
    'packages/modules/versus/ui/detail.tsx':['useRecordScope','tally'],
    'packages/modules/fc_versus/ui/fco-versus-detail.tsx':['useRecordScope'],
  };
  for(const name of needs[file] ?? []) if(!imported.has(name) || !calls.has(name)) problems.push(`공통 규칙 호출 누락: ${name}`);
  return [...new Set(problems)];
}
export function fontLiterals(source: string): Record<string,number> {
  const result: Record<string,number> = {};
  for(const match of source.matchAll(/font-size\s*:\s*(\d*\.?\d+(?:px|rem|em))|text-\[(\d*\.?\d+(?:px|rem|em))\]/g)) {
    const key=match[1] ?? match[2]; result[key]=(result[key] ?? 0)+1;
  }
  return result;
}
