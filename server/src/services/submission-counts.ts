/**
 * 「人提需求」的提交计数（阶段八 8f）。只记通道、请求有没有带登录凭据、认没认出人，按天（UTC）累计次数。
 * 不记任何提交内容、提交人、来源地址。计数出错不影响提交本身。
 */
import { db } from '../db.ts';

export type SubmissionChannel = 'task-center.intake' | 'task-center.publish' | 'app-data.rest' | 'app-data.tool';

export function countSubmission(channel: SubmissionChannel, hasCredential: boolean, resolved: boolean): void {
  try {
    db.prepare(`INSERT INTO submission_counts (day, channel, has_credential, resolved, n) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT (day, channel, has_credential, resolved) DO UPDATE SET n = n + 1`)
      .run(new Date().toISOString().slice(0, 10), channel, hasCredential ? 1 : 0, resolved ? 1 : 0);
  } catch (e) {
    console.error(`[submission-counts] 没记上（不影响提交）：${(e as Error)?.message ?? e}`);
  }
}
