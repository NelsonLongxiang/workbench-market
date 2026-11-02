/** 凭据库主密码门槛（lifecycle-os 协调会话代属主定案，2026-11-01）：只管**新建库**；已有库照常解锁，只提示低于标准。
 *  阈值都在 MASTER_POLICY 里，属主要调改这一处即可（vault-smoke 的红测按这里的值断言）。
 *  常见口令表 = SecLists `Passwords/Common-Credentials/10k-most-common.txt`（MIT，提交 913b327，许可证见同目录 LICENSE.SecLists），
 *  并上上游 breach.ts 的内置表；比对复用上游 estimateStrength 的变形规则（大小写、l33t、首尾加数字/符号）。 */
import { readFileSync } from 'node:fs';
import { WEAK_PASSWORDS } from '../vault/breach.ts';
import { estimateStrength, type StrengthResult } from '../vault/password-strength.ts';

export const MASTER_POLICY = {
  /** 最少字符数（按 Unicode 字符计，中文一个字算一个） */
  minLength: 12,
  /** 不能全是数字 */
  rejectAllDigits: true,
  /** 命中常见弱口令表（含变形）就拒 */
  rejectCommon: true,
  /** 强度评估为「弱」（score < 40，键盘连按/连续字符/重复片段等）也拒——监督席建议，超出定案三条，不要可关 */
  rejectWeakVerdict: true,
};

const COMMON = new Set<string>(WEAK_PASSWORDS);
for (const line of readFileSync(new URL('./common-passwords-10k.txt', import.meta.url), 'utf8').split('\n')) {
  const w = line.trim().toLowerCase();
  if (w) COMMON.add(w);
}
export const COMMON_PASSWORD_COUNT = COMMON.size;

const PATTERN_LABEL: Record<string, string> = {
  keyboard: '键盘连按（qwerty / 1234）', sequence: '连续字符（abcd / 4321）', date: '日期或年份', 'repeat-block': '重复片段',
  repeats: '连续重复的字符', 'word+digits': '单词加几位数字', 'low-diversity': '字符种类太少',
};

export interface MasterCheck { ok: boolean; reasons: string[]; strength: StrengthResult }

export function checkMasterPassword(password: string): MasterCheck {
  const strength = estimateStrength(password, COMMON);
  const reasons: string[] = [];
  const n = [...password].length;
  if (n < MASTER_POLICY.minLength) reasons.push(`至少 ${MASTER_POLICY.minLength} 个字符（现在 ${n} 个）`);
  if (MASTER_POLICY.rejectAllDigits && /^\d+$/.test(password)) reasons.push('不能全是数字');
  const common = strength.patterns.includes('common') || strength.patterns.includes('common-word');
  if (MASTER_POLICY.rejectCommon && common) reasons.push('是常见弱口令（或只在它前后加了数字、符号、大小写变化）');
  if (MASTER_POLICY.rejectWeakVerdict && !common && strength.verdict === 'weak') {
    const why = strength.patterns.map((p) => PATTERN_LABEL[p]).filter(Boolean);
    reasons.push(`强度评估为「弱」${why.length ? `：${why.join('、')}` : ''}`);
  }
  return { ok: reasons.length === 0, reasons, strength };
}
