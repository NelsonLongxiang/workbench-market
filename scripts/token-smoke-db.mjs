// Test fixture only: never call against a production database.
import { DatabaseSync } from 'node:sqlite';
export function writeLegacyTokenFixture(file, legacy, timeoutMs = 3000) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout=' + timeoutMs);
    db.prepare("UPDATE settings SET value=? WHERE key='admin_token_sha256'").run(legacy);
  } finally { db.close(); }
}
