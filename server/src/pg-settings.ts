/** Native PG settings persistence, not wired into runtime or authentication.
 * Inject an independently validated pool. Values may contain secrets: internal callers only.
 * Native SQL only; no SQLite imports, implicit bootstrap, default settings or fallback writes.
 */
import {withPgTransaction, type PgTransactionPool} from './pg-transaction.ts';
export class PgSettingsError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code=code; }
}
const refuse=(code: string): never=>{throw new PgSettingsError(code);};
function text(value: unknown): string {
  if(typeof value!=='string'||value.includes(String.fromCharCode(0)))refuse('settings_text_invalid');
  return value as string;
}
export async function createNewPgSettingsSchema(pool: PgTransactionPool): Promise<void> {
  await withPgTransaction(pool,async tx=>{await tx.query('CREATE TABLE public.settings(key text PRIMARY KEY,value text NOT NULL)');});
}
export function createPgSettings(pool: PgTransactionPool) {
  async function putMany(entries: readonly {key: string;value: string}[]): Promise<void> {
    if(!Array.isArray(entries))refuse('settings_entries_invalid');
    const seen=new Set<string>();
    // Copy and validate all primitives before checkout; never reread mutable caller input after await.
    const snapshot=entries.map(entry=>{
      if(!entry||typeof entry!=='object')refuse('settings_entries_invalid');
      const key=text(entry.key),value=text(entry.value);
      if(seen.has(key))refuse('settings_duplicate_key');
      seen.add(key);return {key,value};
    });
    await withPgTransaction(pool,async tx=>{
      // Canonical lock ordering avoids inverse batch ordering deadlocks; no implicit transaction retries.
      for(const {key,value} of snapshot.sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0))
        await tx.query('INSERT INTO public.settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,value]);
    });
  }
  return Object.freeze({
    async get(rawKey: string): Promise<{value: string}|undefined> {
      const key=text(rawKey);
      return withPgTransaction(pool,async tx=>{
        const found=await tx.query('SELECT value FROM public.settings WHERE key=$1',[key]);
        return found.rows.length?{value:found.rows[0].value as string}:undefined;
      });
    },
    async has(rawKey: string): Promise<boolean> {
      const key=text(rawKey);
      return withPgTransaction(pool,async tx=>(await tx.query('SELECT 1 FROM public.settings WHERE key=$1',[key])).rows.length===1);
    },
    async all(): Promise<{key: string;value: string}[]> {
      return withPgTransaction(pool,async tx=>(await tx.query('SELECT key,value FROM public.settings ORDER BY key')).rows as {key: string;value: string}[]);
    },
    async put(key: string,value: string): Promise<void> {await putMany([{key,value}]);},
    putMany,
    async delete(rawKey: string): Promise<boolean> {
      const key=text(rawKey);
      return withPgTransaction(pool,async tx=>(await tx.query('DELETE FROM public.settings WHERE key=$1 RETURNING key',[key])).rows.length===1);
    },
  });
}
