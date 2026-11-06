/** Explicit YGL task source identity; never fall back from PG configuration to SQLite. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export interface YglTaskSource { backend: 'pg' | 'sqlite'; home: string; workspaceKey: string; dbUrl?: string }
export type YglTaskSourceResult = { ok: true; source: YglTaskSource } | { ok: false; error: 'ygl_home_required' | 'ygl_source_config_invalid' };

/** Matches ygl-trees pgTargetHash: identity is host/port/database, never password or username. */
export function yglPgTargetHash(raw: string): string {
  const u = new URL(raw);
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname || u.hash) throw new Error('invalid PG target');
  for (const k of u.searchParams.keys()) {
    if (/^(host|hostaddr|port|dbname|database|service|servicefile|options)$/i.test(k)) throw new Error('PG target override');
  }
  // The identity hash decodes the database name, while the pg driver keeps reserved characters
  // percent-encoded (decodeURI). Names where the two disagree would collide across real databases
  // while binding and read grants follow the hash, so they are refused outright.
  const rawDb = u.pathname.slice(1);
  if (decodeURI(rawDb) !== decodeURIComponent(rawDb)) throw new Error('ambiguous PG database name');
  const id = [u.hostname.toLowerCase(), u.port || '5432', decodeURIComponent(rawDb)];
  if (!id[2]) throw new Error('PG database required');
  return 'sha256:' + createHash('sha256').update(JSON.stringify(id)).digest('hex');
}

export function resolveYglTaskSource(env: NodeJS.ProcessEnv = process.env): YglTaskSourceResult {
  const home = env.YGL_HOME;
  if (!home || !isAbsolute(home)) return { ok: false, error: 'ygl_home_required' };
  const file = join(home, 'ygl-trees.db'), bindingFile = join(home, 'pg-binding.json');
  const urlFile = env.YGL_DB_URL_FILE;
  // Presence is explicit intent: even an empty URL/file must not silently select SQLite.
  const configuredPg = urlFile !== undefined || env.YGL_DB_URL !== undefined;
  try {
    if (configuredPg) {
      if (existsSync(file)) throw new Error('mixed backends');
      if (urlFile !== undefined && (!isAbsolute(urlFile) || !statSync(urlFile).isFile())) throw new Error('invalid PG secret path');
      const raw = urlFile !== undefined ? readFileSync(urlFile, 'utf8').trim() : env.YGL_DB_URL!;
      if (!raw) throw new Error('empty PG target');
      const hash = yglPgTargetHash(raw);
      if (existsSync(bindingFile)) {
        const b = JSON.parse(readFileSync(bindingFile, 'utf8'));
        if (b?.mode !== 'pg' || b.url_hash !== hash) throw new Error('binding mismatch');
      }
      // Separate namespace from old file-path grants. Credential rotation keeps this key stable.
      const workspaceKey = createHash('sha256').update('ygl-trees:pg:' + hash).digest('hex');
      return { ok: true, source: { backend: 'pg', home, workspaceKey, dbUrl: raw } };
    }
    if (existsSync(bindingFile)) throw new Error('PG target missing; no SQLite fallback');
    if (!statSync(file).isFile()) return { ok: false, error: 'ygl_home_required' };
    return { ok: true, source: { backend: 'sqlite', home, workspaceKey: createHash('sha256').update(realpathSync(file)).digest('hex') } };
  } catch { return { ok: false, error: configuredPg || existsSync(bindingFile) ? 'ygl_source_config_invalid' : 'ygl_home_required' }; }
}
