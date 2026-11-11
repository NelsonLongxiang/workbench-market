/** 当前登录身份（登录门的 /api/auth/me）：外壳的用户卡、全景的问候语用。拿不到就是 null，不弹口令。
 *  单独一个文件：事项详情那条线（#565）在 api.ts 里也有一份同名函数，两边先后合进 main 时不撞名；都合了以后收成一份。 */
export type Me = { authenticated?: boolean; login?: string | null; via?: string | null; display_name?: string | null };
export async function getMe(): Promise<Me | null> {
  try { const r = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }); return r.ok ? await r.json() as Me : null; } catch { return null; }
}
