#!/usr/bin/env node
/** One-time #1087 batch. Write operations require the market service and other writers to be stopped. */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { previewStaleSopRuns, updateStaleSopRuns } from '../server/src/services/sop-run-closure.ts';

function main([mode, pathFlag, file, batchFlag, batch, ...rest]) {
  const dry = mode === 'dry-run';
  if ((!dry && mode !== 'close' && mode !== 'undo') || pathFlag !== '--db' || !file || rest.length
    || (dry ? batchFlag !== undefined : batchFlag !== '--batch' || !batch)) {
    throw new Error('用法：sop-run-closure.mjs dry-run --db <数据库> | close|undo --db <数据库> --batch <批次号>');
  }
  const path = resolve(file);
  if (!statSync(path).isFile()) throw new Error('指定的数据库路径不是普通文件');
  const connection = new DatabaseSync(path, { readOnly: dry, timeout: 5000 });
  try {
    const result = dry ? previewStaleSopRuns(connection) : updateStaleSopRuns(connection, mode, batch);
    console.log(JSON.stringify(result, null, 2));
  } finally { connection.close(); }
}

try { main(process.argv.slice(2)); }
catch (error) {
  console.error('[sop-run-closure] ' + error.message);
  process.exitCode = 1;
}
