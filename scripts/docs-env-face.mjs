#!/usr/bin/env node
/**
 * D8 environment face (#346, ruling B).
 * Compares configuration keys the program reads at runtime against the keys README declares.
 * Counted: process.env.NAME, process.env['NAME'], destructuring, an alias of process.env, and a
 * helper that indexes process.env with its own parameter then gets called with a string literal.
 * Not counted: comments, docs, tests/fixtures, dead branches. Dynamic keys are reported separately.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'tmp', 'coverage'])
const SCAN_ROOTS = ['server/src', 'web/src']
const SEP = String.fromCharCode(92)
const TICK = String.fromCharCode(96)
const Q = String.fromCharCode(39) + '"'.replace('"','')

const rx = (source, flags) => new RegExp(source, flags)

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(mjs|js|cjs|ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

export function readEnvKeys(text) {
  const keys = new Set()
  const dynamic = []
  for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) keys.add(m[1])
  for (const m of text.matchAll(/process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) keys.add(m[1])
  for (const m of text.matchAll(/\{[^}]*\}\s*=\s*process\.env\b/g)) {
    for (const part of m[0].slice(1, m[0].indexOf('}')).split(',')) {
      const name = part.split(':')[0].trim()
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) keys.add(name)
    }
  }
  const aliases = new Set()
  // Parameter-injected env objects: functions take `env` and index it (the ruling counts these).
  for (const m of text.matchAll(/\b(?:env|environment|processEnv)\.([A-Z][A-Z0-9_]*)/g)) keys.add(m[1])
  for (const m of text.matchAll(/\b(?:env|environment|processEnv)\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) keys.add(m[1])
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\b/g)) aliases.add(m[1])
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{[^}]*\.\.\.process\.env\b/g)) aliases.add(m[1])
  for (const a of aliases) {
    for (const m of text.matchAll(new RegExp('\\b' + a + '\\.([A-Za-z_][A-Za-z0-9_]*)', 'g'))) keys.add(m[1])
    for (const m of text.matchAll(new RegExp('\\b' + a + '\\[\\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\\s*\\]', 'g'))) keys.add(m[1])
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(?\s*([A-Za-z_$][\w$]*)\s*(?::[^)]*)?\)?\s*=>[^;\n]*process\.env\[\s*\2\s*\]/g)) {
    const fn = m[1]
    for (const call of text.matchAll(new RegExp('\\b' + fn + '\\(\\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]\\s*\\)', 'g'))) keys.add(call[1])
  }
  // Function-declaration helpers: function envInt(name, ...) { ... process.env[name] ... } then envInt('KEY', ...)
  for (const m of text.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)[\s\S]{0,400}?process\.env\[\s*\2\s*\]/g)) {
    const fn = m[1]
    for (const call of text.matchAll(new RegExp('\\b' + fn + '\\(\\s*[\'"]([A-Za-z_][A-Za-z0-9_]*)[\'"]', 'g'))) keys.add(call[1])
  }
  for (const m of text.matchAll(/process\.env\[\s*[^'"\]]+\s*\]/g)) dynamic.push(m[0])
  return { keys: [...keys], dynamic }
}

const ENV_NAME = /^(PORT|TZ|NODE_ENV|NODE_OPTIONS|ADMIN_TOKEN|DATA_DIR|REDIS_URL|MARKET_TEAM|MARKET_PUBLIC_URL|MCP_GATEWAY|PUBLISH_LOCK_MS|ALLOW_PUBLIC_NET|(WM|LC|A2A|MCP|DSH|YGL|LAYERFS|SANDBOX|AI|EVAL|PUBLISH|SOP|RUN|TASK)_[A-Z0-9_]+)$/

export function readDocumentedKeys(text) {
  const keys = new Set()
  // Odd segments of a split on the backtick are the code spans; a span declares a key whether it is
  // bare (WM_FOO) or carries a value (WM_FOO=1). Splitting avoids the pairing drift a regex has when a
  // span is longer than the quantifier allows.
  const parts = text.split(TICK)
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].split(/[=\s(（]/)[0].trim()
    if (ENV_NAME.test(name)) keys.add(name)
  }
  return [...keys]
}

// OS/plumbing variables the code reads to locate itself, not configuration the README should list.
const PLUMBING = new Set(['PATH','HOME','USERPROFILE','SystemRoot','TEMP','TMP','APPDATA','LOCALAPPDATA','PNPM_HOME','NODE_ENV','GITHUB_STEP_SUMMARY'])
// Screaming-case names that are protocol codes, not configuration: the README mentions them as values.
const NON_CONFIG = new Set(['LC_APPROVAL_READ_ONLY'])

export function compare(documented, runtime) {
  const doc = new Set(documented.filter(k => !NON_CONFIG.has(k) && !PLUMBING.has(k)))
  const run = new Set(runtime.filter(k => !PLUMBING.has(k)))
  return { extra: [...doc].filter(k => !run.has(k)).sort(), missing: [...run].filter(k => !doc.has(k)).sort() }
}

export function scanRepo(root) {
  const perKey = new Map()
  const dynamic = []
  for (const rel of SCAN_ROOTS) for (const file of walk(join(root, rel))) {
    const text = readFileSync(file, 'utf8')
    const { keys, dynamic: dyn } = readEnvKeys(text)
    for (const k of keys) {
      if (!perKey.has(k)) perKey.set(k, [])
      perKey.get(k).push(relative(root, file).split(SEP).join('/'))
    }
    for (const d of dyn) dynamic.push({ file: relative(root, file).split(SEP).join('/'), expr: d })
  }
  const documented = readDocumentedKeys(readFileSync(join(root, 'README.md'), 'utf8'))
  const runtime = [...perKey.keys()].filter(k => /^[A-Z][A-Z0-9_]*$/.test(k))
  const { extra, missing } = compare(documented, runtime)
  return { documented: documented.sort(), runtime: runtime.sort(), extra, missing, dynamic, perKey }
}

const self = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split(SEP).join('/').split('/').slice(-2).join('/'))
if (self) {
  const root = process.argv[2] ?? process.cwd()
  const r = scanRepo(root)
  const out = { ok: r.extra.length === 0 && r.missing.length === 0, documented_count: r.documented.length, runtime_count: r.runtime.length, extra: r.extra, missing: r.missing, dynamic_count: r.dynamic.length }
  console.log(JSON.stringify(out, null, 2))
  process.exitCode = out.ok ? 0 : 1
}
