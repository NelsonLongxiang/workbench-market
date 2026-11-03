#!/usr/bin/env node
/**
 * Red-first test for the D8 environment face (#346 ruling B).
 *
 * The rule: the configuration keys README declares must equal the keys the program actually reads at
 * runtime — direct process.env access, an env object passed in, and helper-injected reads all count.
 * README-only keys are 多列; code-only keys are 漏列; either one fails D8.
 *
 * Before the README fix this file fails on the repository assertion at the bottom; that failure is the
 * point of the test. The unit fixtures pin the scanner so a future refactor cannot quietly stop counting
 * a read shape (helper injection is the shape the old literal scan missed).
 */
import assert from 'node:assert/strict'
import { readEnvKeys, readDocumentedKeys, compare, scanRepo } from './docs-env-face.mjs'

const TICK = String.fromCharCode(96)
const cases = []
const check = (name, fn) => { try { fn(); cases.push({ name, ok: true }) } catch (e) { cases.push({ name, ok: false, error: e.message }) } }

check('direct member read', () => {
  assert.deepEqual(readEnvKeys('const a = process.env.WM_FOO').keys, ['WM_FOO'])
})
check('bracket read', () => {
  assert.deepEqual(readEnvKeys('const a = process.env[\'WM_BAR\']').keys, ['WM_BAR'])
})
check('destructuring read', () => {
  const { keys } = readEnvKeys('const { WM_A, WM_B } = process.env')
  assert.deepEqual(keys.sort(), ['WM_A', 'WM_B'])
})
check('alias of process.env', () => {
  assert.deepEqual(readEnvKeys('const env2 = process.env\nconst a = env2.WM_ALIAS').keys, ['WM_ALIAS'])
})
check('arrow helper injection', () => {
  const text = 'const v = (k) => String(process.env[k] ?? \'\').trim()\nconst a = v(\'WM_HELP\')'
  assert.deepEqual(readEnvKeys(text).keys, ['WM_HELP'])
})
check('function helper injection with a type annotation', () => {
  const text = 'function envInt(name: string, def: number) { return Number(process.env[name] ?? def) }\nconst n = envInt(\'WM_FN\', 200)'
  assert.deepEqual(readEnvKeys(text).keys, ['WM_FN'])
})
check('env object parameter', () => {
  assert.deepEqual(readEnvKeys('export function surf(env) { return env.WM_PARAM }').keys, ['WM_PARAM'])
})
check('comment-only mention is not a read', () => {
  assert.deepEqual(readEnvKeys('// WM_COMMENT is only mentioned here\nconst a = 1').keys, [])
})
check('dynamic key is reported, not counted', () => {
  const r = readEnvKeys('const k = pick()\nconst a = process.env[k]')
  assert.deepEqual(r.keys, [])
  assert.equal(r.dynamic.length, 1)
})
check('README bare span declares a key', () => {
  assert.deepEqual(readDocumentedKeys('env: ' + TICK + 'WM_FOO' + TICK + ' and ' + TICK + 'PORT' + TICK).sort(), ['PORT', 'WM_FOO'])
})
check('README span carrying a value still declares the key', () => {
  assert.deepEqual(readDocumentedKeys('set ' + TICK + 'WM_DEV_ORIGIN=1' + TICK + ' to enable'), ['WM_DEV_ORIGIN'])
})
check('compare names both directions', () => {
  const r = compare(['WM_DOC_ONLY', 'WM_BOTH'], ['WM_CODE_ONLY', 'WM_BOTH'])
  assert.deepEqual(r.extra, ['WM_DOC_ONLY'])
  assert.deepEqual(r.missing, ['WM_CODE_ONLY'])
})
check('repository: README and runtime keys agree', () => {
  const r = scanRepo(process.cwd())
  assert.deepEqual(r.extra, [], 'README lists keys the program never reads: ' + r.extra.join(', '))
  assert.deepEqual(r.missing, [], 'program reads keys README never lists: ' + r.missing.join(', '))
})

const failed = cases.filter(c => !c.ok)
for (const c of cases) console.log((c.ok ? 'ok   ' : 'FAIL ') + c.name + (c.ok ? '' : ' :: ' + c.error))
console.log(JSON.stringify({ total: cases.length, failed: failed.length }))
process.exitCode = failed.length === 0 ? 0 : 1
