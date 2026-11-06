/** Native PG preparation: one checked-out connection per transaction, no implicit retries.
 * Inject a pg-compatible pool; this module neither opens storage nor changes backend selection.
 * All statements use native PostgreSQL SQL/parameters. No SQLite translation or nested transactions.
 */
export type PgResult = { rows: Record<string, unknown>[]; rowCount: number | null; command?: string };
export type PgTransactionClient = {
  query: (sql: string, values?: unknown[]) => Promise<PgResult>;
  release: (destroy?: boolean) => void;
  on: (event: 'error', listener: (error: Error) => void) => unknown;
  removeListener: (event: 'error', listener: (error: Error) => void) => unknown;
};
export type PgTransactionPool = { connect: () => Promise<PgTransactionClient> };
export type PgTransaction = { query: (sql: string, values?: readonly unknown[]) => Promise<PgResult> };

/** The callback's query scope expires when it settles. In-flight statements drain before COMMIT/ROLLBACK.
 * A rejected query poisons the whole transaction even if the callback catches its rejection.
 * A failed COMMIT has uncertain outcome: discard the connection, propagate the error, never retry.
 * The injected client/pool must not be used outside this wrapper during its checkout.
 * The callback is trusted server code: do not pass raw transaction-control SQL, stored routines
 * that end transactions, or untrusted SQL. This is not an SQL firewall or a query timeout policy.
 */
export async function withPgTransaction<T>(pool: PgTransactionPool, work: (tx: PgTransaction) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const pending = new Set<Promise<PgResult>>();
  let accepting = false, began = false, committing = false, destroy = false;
  let failed = false, failure: unknown;
  const poison = (error: unknown) => { if (!failed) { failed = true; failure = error; } };
  const connectionError = (error: Error) => { destroy = true; poison(error); };
  client.on('error', connectionError);
  const tx: PgTransaction = Object.freeze({
    query(sql: string, values: readonly unknown[] = []): Promise<PgResult> {
      if (!accepting) return Promise.reject(new Error('pg_transaction_scope_closed'));
      let result: Promise<PgResult>;
      try { result = Promise.resolve(client.query(sql, [...values])); }
      catch (error) { poison(error); result = Promise.reject(error); }
      pending.add(result);
      // Observe every failure, including a forgotten/caught query promise, without swallowing it for callers.
      void result.then(() => pending.delete(result), error => { poison(error); pending.delete(result); });
      return result;
    },
  });
  const drain = async () => { await Promise.allSettled([...pending]); };
  try {
    try { await client.query('BEGIN'); began = true; } catch (error) { destroy = true; throw error; }
    if (failed) throw failure;
    accepting = true;
    let output: T;
    try { output = await work(tx); }
    finally { accepting = false; await drain(); }
    if (failed) throw failure;
    committing = true;
    await client.query('COMMIT');
    began = false;
    if (failed) throw failure;
    return output;
  } catch (error) {
    accepting = false;
    if (committing) destroy = true; // cannot infer commit outcome or safely replay the callback
    else if (began) {
      try { await client.query('ROLLBACK'); } catch { destroy = true; }
    }
    throw error;
  } finally {
    accepting = false;
    client.removeListener('error', connectionError);
    client.release(destroy);
  }
}
