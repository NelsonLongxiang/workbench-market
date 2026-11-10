// 演示用：故意违规，下一个提交撤掉。
import { db } from './db.ts';
export enum CiRedDemo { A }
export const ciRedDemo = db.prepare('SELECT 1').get();
