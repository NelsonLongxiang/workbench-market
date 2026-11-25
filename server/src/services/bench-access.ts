import { judge, scopedVerdict, type JudgedActor } from '../judgment.ts';
import { ASKED, scopedKind } from '../judgment-builtins.ts';
import { relationOf } from '../team-relation.ts';
import type { Kind } from '../roles.ts';
import type { BenchEntry } from './bench-registry.ts';

const globalKind = (action: string): Kind => { const a = ASKED[action]; if (!a) throw new Error(`数据视图的动作 ${action} 没有登记问判定的类别（judgment-builtins.ts 的 ASKED）`); return a.global; };
export const everywhere = (actor: JudgedActor, action: string): boolean => judge({ actor, action, kind: globalKind(action), declared: true }).verdict === 'allow';
export const inDept = (actor: JudgedActor, action: string, department: string): boolean => {
  const kind = scopedKind(action);
  return kind !== null && actor.type === 'principal' && scopedVerdict({ principal: actor.id, action, kind, scope: `dept:${department}` }).verdict === 'allow';
};
export function within(actor: JudgedActor, action: string, bench: BenchEntry | null): boolean {
  if (actor.type !== 'principal' || !bench || !bench.department_id) return false;
  if (!inDept(actor, action, bench.department_id)) return false;
  if (!bench.team || scopedKind(action) === 'decide') return true;
  if (inDept(actor, 'bench-store.mcp-decide', bench.department_id)) return true;
  const rel = relationOf({ principal: actor.id }, { team: { host: bench.team_host, team: bench.team } }).relations;
  return rel.includes('team-lead') || rel.includes('seat-owner');
}

export function canBenchAction(actor: JudgedActor, action: string, bench: BenchEntry | null): boolean {
  return everywhere(actor, action) || within(actor, action, bench);
}
