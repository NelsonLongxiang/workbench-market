#!/usr/bin/env node
/**
 * 主体服务的单测：两张表的约束，和「把外部身份对到主体上」这件事。
 * 进程内，开一个临时数据目录里的库；不起服务，不访问任何外部系统。
 *
 *   node scripts/principal-service-test.mjs              测本仓库
 *   node scripts/principal-service-test.mjs --root DIR   测另一棵目录树（变异测试用）
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = process.argv.indexOf('--root');
const ROOT = resolve(arg >= 0 ? process.argv[arg + 1] : join(HERE, '..'));
const OUT = join(HERE, '..', 'tmp', `principal-service-${process.pid}-${Date.now().toString(36)}`);
const at = (p) => pathToFileURL(join(ROOT, p)).href;

/**
 * 子进程：在同一个数据目录上再开一个连接，把同一批外部身份各对一遍。输出每个身份对到的主体（或错误）。
 * 开好库先报 OPENED，等父进程从标准输入发话再一起开跑：要撞的是「对到主体」这一步，不是开库。
 */
const WORKER = `
const [rootContext, service, logins] = process.argv.slice(1);
const { root } = await import(rootContext);
const { PrincipalService } = await import(service);
await root.plugin(PrincipalService);
const p = root.get('principals');
console.log('OPENED');
await new Promise((go) => process.stdin.once('data', go));
const out = {};
for (const login of JSON.parse(logins)) {
  for (let i = 0; i < 40; i++) {
    try { const a = p.admit({ provider: 'fake', externalId: login, displayName: 'worker ' + process.pid }); out[login] = a.ok ? a.principal : a.reason; break; }
    catch (e) { out[login] = 'error: ' + String(e?.message ?? e); await new Promise((r) => setTimeout(r, 15)); }
  }
}
console.log('RESULT=' + JSON.stringify(out));
`;

let pass = 0, fail = 0;
const check = (ok, label, detail = '') => { if (ok) pass++; else fail++; console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || !detail ? '' : `（${detail}）`}`); };
const show = (v) => JSON.stringify(v);
const throws = (fn) => { try { fn(); return ''; } catch (e) { return String(e?.message ?? e) || 'threw'; } };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
process.env.DATA_DIR = OUT;
try {
  const { db } = await import(at('server/src/db.ts'));
  const { root } = await import(at('server/src/root-context.ts'));
  const { PrincipalService } = await import(at('server/src/services/principal.ts'));
  await root.plugin(PrincipalService);
  const principals = root.get('principals');
  /** 预期被拒的调用：抛错（靠表的唯一约束炸开）也算没过，服务该自己判出来、回 unbound */
  const tryAdmit = (x) => { try { return principals.admit(x); } catch (e) { return { threw: String(e?.message ?? e) }; } };
  const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  const insert = (id, kind, owner = '') => db.prepare('INSERT INTO principals (id, id_key, kind, owner) VALUES (?, ?, ?, ?)').run(id, id.toLowerCase(), kind, owner);

  // ---------- 一、表的约束：五类、标识前缀、责任人 ----------
  check(count('principals') === 0 && count('principal_identities') === 0, '新库：两张表都在，都是空的');
  insert('user:owner', 'person');
  for (const [id, kind] of [['seat:s1', 'seat'], ['app:a1', 'app'], ['system:y1', 'system'], ['node:n1', 'node']]) {
    const noOwner = throws(() => insert(id, kind));
    const withOwner = throws(() => insert(id, kind, 'user:owner'));
    check(/CHECK/i.test(noOwner) && withOwner === '', `${kind}：没有责任人建不出来，有责任人可以`, `没有责任人：${noOwner || '建成了'}；有责任人：${withOwner || '建成了'}`);
  }
  check(throws(() => insert('user:nobody-owns-me', 'person')) === '', '对照·人：不要求责任人');
  {
    const wrong = [['seat:x', 'person'], ['user:x', 'seat'], ['node:x', 'seat'], ['alice', 'person'], ['user:', 'person'], ['USER:x', 'person'], ['app:x', 'node']];
    const leaked = wrong.filter(([id, kind]) => !/CHECK/i.test(throws(() => insert(id, kind, 'user:owner'))));
    check(leaked.length === 0, `标识的前缀要和类别对得上（${wrong.length} 种写错的都建不出来）`, show(leaked));
  }
  check(/CHECK/i.test(throws(() => insert('user:k', 'robot'))) && /CHECK/i.test(throws(() => insert('node:k', 'robot', 'user:owner'))) && /CHECK/i.test(throws(() => db.prepare("INSERT INTO principals (id, id_key, kind, status) VALUES ('user:st', 'user:st', 'person', 'paused')").run())), '类别只有五种，状态只有启用和停用');
  check(/UNIQUE|PRIMARY/i.test(throws(() => insert('user:owner', 'person'))), '主体标识唯一');
  db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', 'dup', 'dup', 'user:owner')").run();
  check(/UNIQUE|PRIMARY/i.test(throws(() => db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', 'dup', 'dup', 'user:nobody-owns-me')").run())), '外部身份：提供方加对方的用户标识唯一，同一个身份不能挂到两个主体上');
  check(throws(() => db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('other', 'dup', 'dup', 'user:nobody-owns-me')").run()) === '', '对照：换一个提供方，同名的用户标识是另一个身份');
  check(/CHECK/i.test(throws(() => db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('', 'x', 'x', 'user:owner')").run())) && /CHECK/i.test(throws(() => db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', '', '', 'user:owner')").run())), '外部身份：提供方和用户标识都不能是空的');
  db.exec('DELETE FROM principal_identities; DELETE FROM principals;');

  // ---------- 二、对到主体：第一次见到就建，之后都是同一个 ----------
  const alice = { provider: 'fake', externalId: 'alice', displayName: 'Alice A' };
  const first = principals.admit(alice);
  check(first.ok === true && first.principal === 'user:alice' && count('principals') === 1 && count('principal_identities') === 1, '第一次见到：建一个人 user:alice 和一条外部身份', show(first));
  {
    const row = principals.get('user:alice');
    check(row?.kind === 'person' && row.status === 'active' && row.display_name === 'Alice A' && row.owner === '' && show(row.identities.map((i) => [i.provider, i.external_id])) === show([['fake', 'alice']]), '建出来的主体：人、启用、带显示名，外部身份是（fake, alice）', show(row));
  }
  let same = true;
  for (let i = 0; i < 200; i++) { const a = principals.admit({ ...alice, displayName: `Alice ${i}` }); if (!a.ok || a.principal !== 'user:alice') same = false; }
  check(same && count('principals') === 1 && count('principal_identities') === 1 && principals.get('user:alice').display_name === 'Alice A', '同一个人反复登录 200 次：还是那一个主体，不多建，显示名不被后来的登录改掉', `主体 ${count('principals')} 个，外部身份 ${count('principal_identities')} 条`);
  {
    const other = principals.admit({ provider: 'other', externalId: 'bob', displayName: null });
    const row = principals.get('user:bob');
    check(other.ok === true && other.principal === 'user:bob' && row?.display_name === '' && principals.principalOf('other', 'bob') === 'user:bob' && principals.principalOf('fake', 'bob') === null, '对照：另一个提供方认出的另一个人，另建一个主体；外部身份按提供方分开', show([other, row]));
  }

  // ---------- 三、停用与恢复 ----------
  {
    const off = principals.setStatus('user:alice', 'disabled', 'admin-token', '离职');
    const refused = principals.admit(alice);
    check(off?.changed === true && off.principal.status === 'disabled' && off.principal.status_changed_by === 'admin-token' && off.principal.status_reason === '离职' && /^\d{4}-\d{2}-\d{2} /.test(off.principal.status_changed_at)
      && refused.ok === false && refused.reason === 'disabled' && first.ok === true, '停用：状态改了，记下谁、什么时候、为什么；再来登录不认（disabled）', show([off, refused]));
    let leaked = false;
    for (let i = 0; i < 50; i++) if (principals.admit(alice).ok) leaked = true;
    check(!leaked && count('principals') === 2 && count('principal_identities') === 2 && principals.get('user:alice').status === 'disabled', '停用之后反复登录：一直不认，不会另建一个主体，状态也不会被登录改回去');
    check(principals.admit({ provider: 'other', externalId: 'bob', displayName: null }).ok === true, '对照：停用 alice 不影响 bob');
    const again = principals.setStatus('user:alice', 'disabled', 'someone-else', '重复停用');
    check(again?.changed === false && again.principal.status_changed_by === 'admin-token' && again.principal.status_reason === '离职', '已经停用的再停用一次：不算变更，上一次的记录不被覆盖', show(again));
    const on = principals.setStatus('user:alice', 'active', 'cli', '回来了');
    const back = principals.admit(alice);
    check(on?.changed === true && on.principal.status === 'active' && on.principal.status_changed_by === 'cli' && back.ok === true && back.principal === 'user:alice' && refused.ok === false, '恢复：立即照常认得出，还是原来那个主体', show([on, back]));
    check(principals.setStatus('user:nobody', 'disabled', 'cli', '') === null && count('principals') === 2, '停用一个不存在的主体：说没有，不会凭空建一个');
  }

  // ---------- 四、不自动认领 ----------
  {
    insert('user:carol', 'person'); // 标识已经有主了，却没有绑定这个外部身份
    const n = count('principal_identities');
    const a = tryAdmit({ provider: 'fake', externalId: 'carol', displayName: 'Carol' });
    check(a.ok === false && a.reason === 'unbound' && count('principal_identities') === n && principals.principalOf('fake', 'carol') === null, '标识被一个已有的主体占着、外部身份没绑定：不认，也不替它绑上', show(a));
    db.prepare("INSERT OR IGNORE INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', 'carol', 'carol', 'user:carol')").run(); // 管理员对一次
    const b = principals.admit({ provider: 'fake', externalId: 'carol', displayName: 'Carol' });
    check(b.ok === true && b.principal === 'user:carol' && a.ok === false, '对照：绑定之后就认');
  }
  {
    // 外部身份可以绑到名字不一样的主体上（以后同一个人挂多个身份用）
    db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('other', 'a.lice', 'a.lice', 'user:alice')").run();
    const a = principals.admit({ provider: 'other', externalId: 'a.lice', displayName: null });
    check(a.ok === true && a.principal === 'user:alice' && principals.get('user:alice').identities.length === 2, '一个主体可以有多个外部身份：另一个身份对到的是同一个主体', show(a));
    principals.setStatus('user:alice', 'disabled', 'cli', '');
    const both = [principals.admit(alice), principals.admit({ provider: 'other', externalId: 'a.lice', displayName: null })];
    check(both.every((x) => x.ok === false && x.reason === 'disabled'), '停用主体：它名下的每个外部身份都不认', show(both));
    principals.setStatus('user:alice', 'active', 'cli', '');
  }
  {
    // 登录认出来的只能是人
    insert('seat:robot', 'seat', 'user:alice');
    db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', 'robot', 'robot', 'seat:robot')").run();
    const a = tryAdmit({ provider: 'fake', externalId: 'robot', displayName: null });
    check(a.ok === false && a.reason === 'unbound', '外部身份绑在席位上：不能拿来登录', show(a));
    const row = principals.pending().find((x) => x.provider === 'fake' && x.external_id === 'robot');
    check(row?.reason === 'bound-to-non-person', '绑在席位上的账号进待对接清单时单列原因（bound-to-non-person），管理员看得出要先解绑、不是点对接', show(row));
  }
  {
    // 再来时只更新这几样：这一次没带邮箱、显示名，不拿空值盖掉原来的
    principals.notePending({ provider: 'mail', externalId: 'keep-me', displayName: '原来的名字', email: 'keep@example.invalid' });
    principals.notePending({ provider: 'mail', externalId: 'keep-me', displayName: null, email: null });
    const kept = principals.pending().find((x) => x.provider === 'mail' && x.external_id === 'keep-me');
    principals.notePending({ provider: 'mail', externalId: 'keep-me', displayName: '新名字', email: 'new@example.invalid' });
    const changed = principals.pending().find((x) => x.provider === 'mail' && x.external_id === 'keep-me');
    check(kept?.email === 'keep@example.invalid' && kept?.display_name === '原来的名字' && kept?.reason === 'unbound' && changed?.email === 'new@example.invalid' && changed?.display_name === '新名字'
      && principals.pending().filter((x) => x.external_id === 'keep-me').length === 1,
      '待对接清单：再来时没带邮箱、显示名就留着原来的（不被空值盖掉）；带了新的就换；同一个人只有一条', show({ kept, changed }));
  }

  // ---------- 四之二、登录名的等价写法：比较按规范化之后的值，撞上了不认、不并 ----------
  {
    // 抛错（表的唯一约束兜住了）也算没过：服务该自己判出撞名、回 unbound，不能靠约束炸开
    const admit = (x) => { try { return principals.admit(x); } catch (e) { return { threw: String(e?.message ?? e) }; } };
    const before = count('principals'), ids = count('principal_identities');
    const variants = ['Alice', 'ALICE', '\uff41\uff4c\uff49\uff43\uff45', 'al\u200bice', 'alice\u00ad', '\uff21\uff2c\uff29\uff23\uff25'];
    const answers = variants.map((v) => [v, admit({ provider: 'fake', externalId: v, displayName: null })]);
    const wrong = answers.filter(([, a]) => !(a.ok === false && a.reason === 'unbound'));
    check(wrong.length === 0 && count('principals') === before && count('principal_identities') === ids, `alice 已有主体：登录名只差大小写、全角、夹零宽或软连字符（${variants.length} 种）→ 都不认（unbound），不另建主体，也不替它绑上`, show(wrong));
    principals.setStatus('user:alice', 'disabled', 'cli', '');
    const off = admit({ provider: 'fake', externalId: 'ALICE', displayName: null });
    principals.setStatus('user:alice', 'active', 'cli', '');
    check(off.ok === false && count('principals') === before, '停用 alice 之后换个大小写：照样不认，绕不过停用', show(off));
    // 不同提供方各算各的：另一个提供方的 Alice 撞的是主体标识 user:Alice ≈ user:alice，同样不认
    const other = admit({ provider: 'other', externalId: 'Alice', displayName: null });
    check(other.ok === false && other.reason === 'unbound', '另一个提供方的 Alice：主体标识按规范化撞上 user:alice，不认', show(other));
    // 表这一层也守着：直接往库里写等价写法，唯一约束拒绝
    check(/UNIQUE/i.test(throws(() => db.prepare("INSERT INTO principals (id, id_key, kind) VALUES ('user:ALICE', 'user:alice', 'person')").run())), '表：主体标识按规范化之后的值唯一');
    check(/UNIQUE/i.test(throws(() => db.prepare("INSERT INTO principal_identities (provider, external_id, external_key, principal_id) VALUES ('fake', 'ALICE', 'alice', 'user:alice')").run())), '表：外部身份按提供方加规范化之后的值唯一');
    // 只撞外部身份、不撞主体标识：other 提供方下 a.lice 绑在 user:alice 上，再来 A.LICE（主体标识 user:A.LICE 没人占）
    const dotted = admit({ provider: 'other', externalId: 'A.LICE', displayName: null });
    check(dotted.ok === false && dotted.reason === 'unbound' && principals.get('user:A.LICE') === null, '同一个提供方下外部身份只差大小写（主体标识没撞）：不认、不建', show(dotted));
    // 大写的 ẞ（验收 M1′）：ß 的完整折叠是 ss，ẞ 先折成 ß 还要再折一次
    const st = admit({ provider: 'fake', externalId: 'strasse', displayName: null });
    principals.setStatus('user:strasse', 'disabled', 'cli', '');
    const sharp = ['stra\u1e9ee', 'STRA\u1e9eE', 'stra\u00dfe', 'STRASSE'].map((v) => [v, admit({ provider: 'fake', externalId: v, displayName: null })]);
    principals.setStatus('user:strasse', 'active', 'cli', '');
    check(st.ok === true && sharp.every(([, a]) => a.ok === false) && principals.list().filter((p) => p.id.startsWith('user:stra')).length === 1, '停用 strasse 之后：straẞe、STRAẞE、straße、STRASSE 都不认，不另建主体', JSON.stringify(sharp));
    // 对照：真的不一样的名照常建
    const bob2 = admit({ provider: 'fake', externalId: 'alice2', displayName: null });
    check(bob2.ok === true && bob2.principal === 'user:alice2', '对照：alice2 是另一个人，照常建');
  }

  // ---------- 四之三、管理员对一次：绑定与解绑 ----------
  {
    const bind = (x) => { try { return principals.bindIdentity(x); } catch (e) { return { threw: String(e?.message ?? e) }; } };
    // 变体写法先登录、把本人挡在外面：Kim 先来建了 user:Kim，kim 本人被拒。
    // 等价写法在同一个提供方下只能有一条，所以先解绑旧的那条，再把新写法绑到原来那个主体上（同一个账号改了大小写），或者绑到一个新的人身上
    const squat = principals.admit({ provider: 'fake', externalId: 'Kim', displayName: null });
    const blocked = principals.admit({ provider: 'fake', externalId: 'kim', displayName: null });
    const direct = bind({ provider: 'fake', externalId: 'kim', principal: 'user:Kim' });
    const taken = bind({ provider: 'other', externalId: 'kim', principal: 'user:kim', create: true });
    const was = principals.unbindIdentity('fake', 'Kim');
    const moved = bind({ provider: 'fake', externalId: 'kim', principal: 'user:Kim' });
    const after = principals.admit({ provider: 'fake', externalId: 'kim', displayName: null });
    const oldSpelling = principals.admit({ provider: 'fake', externalId: 'Kim', displayName: null });
    check(squat.ok && blocked.ok === false && direct.ok === false && direct.reason === 'conflict' && taken.ok === false && taken.reason === 'taken' && taken.principal === 'user:Kim'
      && was === 'user:Kim' && moved.ok === true && moved.created === false && after.ok === true && after.principal === 'user:Kim' && oldSpelling.ok === false,
      '变体写法挡住了本人：直接绑等价写法 conflict、新建等价标识 taken；先解绑旧写法再绑新写法，本人登录对到原来的主体，旧写法不再认', JSON.stringify({ squat, blocked, direct, taken, was, moved, after, oldSpelling }));
    const fresh = bind({ provider: 'other', externalId: 'kim-2', principal: 'user:kim.real', create: true, displayName: 'Kim (real)' });
    check(fresh.ok === true && fresh.created === true && principals.get('user:kim.real').display_name === 'Kim (real)' && principals.admit({ provider: 'other', externalId: 'kim-2', displayName: null }).principal === 'user:kim.real',
      '绑到一个新的人身上（create）：新建并绑上，从那条身份登录对到它', JSON.stringify(fresh));
    // 已经绑在别人身上（原值或等价写法）：不改，要先解绑
    const steal = bind({ provider: 'fake', externalId: 'kim', principal: 'user:alice' });
    const stealVariant = bind({ provider: 'fake', externalId: 'KIM', principal: 'user:alice' });
    check(steal.ok === false && steal.reason === 'conflict' && steal.principal === 'user:Kim' && stealVariant.ok === false && stealVariant.reason === 'conflict'
      && principals.admit({ provider: 'fake', externalId: 'kim', displayName: null }).principal === 'user:Kim', '绑在别人身上的外部身份（含等价写法）：不能直接改绑（conflict），原来的绑定不动', JSON.stringify({ steal, stealVariant }));
    // 目标的各种不行
    principals.setStatus('user:alice', 'disabled', 'cli', '');
    const toDisabled = bind({ provider: 'other', externalId: 'alice-feishu', principal: 'user:alice' });
    principals.setStatus('user:alice', 'active', 'cli', '');
    const toMissing = bind({ provider: 'other', externalId: 'ghost', principal: 'user:nobody-here' });
    const toSeat = bind({ provider: 'other', externalId: 'x1', principal: 'seat:robot' });
    const shapes = [{}, { provider: 'Bad', externalId: 'x', principal: 'user:a' }, { provider: 'p', externalId: ' x', principal: 'user:a' }, { provider: 'p', externalId: 'x', principal: 'alice' }, { provider: 'p', externalId: 'x', principal: 'user:' }].map(bind);
    check(toDisabled.reason === 'disabled' && toMissing.reason === 'missing' && toSeat.threw && shapes.every((x) => x.threw) && principals.get('user:nobody-here') === null,
      '绑到停用的人 disabled、不存在的人 missing（不带 create 不新建）、不是人或形状不对抛错', JSON.stringify({ toDisabled, toMissing, toSeat, shapes }));
    // 一个人可以有多条外部身份：飞书那一条绑到已有的 alice 上
    const feishu = bind({ provider: 'feishu', externalId: 'on_0123456789abcdef', principal: 'user:alice' });
    const viaFeishu = principals.admit({ provider: 'feishu', externalId: 'on_0123456789abcdef', displayName: null });
    check(feishu.ok === true && feishu.created === false && viaFeishu.ok === true && viaFeishu.principal === 'user:alice' && principals.get('user:alice').identities.some((i) => i.provider === 'feishu'),
      '把另一个提供方的身份绑到已有的人身上：从那边登录对到同一个主体', JSON.stringify({ feishu, viaFeishu }));
    // 解绑：立即不认；再来就是没见过的身份，按规则走
    const unbound = principals.unbindIdentity('feishu', 'on_0123456789abcdef');
    const none = principals.unbindIdentity('feishu', 'on_0123456789abcdef');
    check(unbound === 'user:alice' && none === null && !principals.get('user:alice').identities.some((i) => i.provider === 'feishu'), '解绑：返回原来绑在谁身上，再解一次说没有');
  }

  // ---------- 五、入参的形状 ----------
  {
    const bad = [null, undefined, {}, { provider: 'fake' }, { provider: '', externalId: 'x' }, { provider: 'Fake', externalId: 'x' }, { provider: 'fa ke', externalId: 'x' }, { provider: 5, externalId: 'x' },
      { provider: 'fake', externalId: '' }, { provider: 'fake', externalId: ' x' }, { provider: 'fake', externalId: 'x ' }, { provider: 'fake', externalId: 'a\u0000b' }, { provider: 'fake', externalId: 'x'.repeat(129) }, { provider: 'fake', externalId: 7 }];
    const n = count('principals');
    const leaked = bad.filter((i) => throws(() => principals.admit(i)) === '');
    check(leaked.length === 0 && count('principals') === n, `外部身份的形状不对（${bad.length} 种）：抛错，不建主体`, show(leaked));
    const ctl = principals.admit({ provider: 'fake', externalId: 'dave', displayName: '  Dave\u0007\n D  ' });
    check(ctl.ok === true && principals.get('user:dave').display_name === 'Dave   D', '显示名里的控制字符换成空格，两头去空白', show(principals.get('user:dave')));
    check(principals.admit({ provider: 'fake', externalId: 'erin', displayName: 12345 }).ok === true && principals.get('user:erin').display_name === '', '显示名不是字符串：当作没有');
  }

  // ---------- 六、列表 ----------
  {
    const list = principals.list();
    const ids = list.map((p) => p.id);
    check(show(ids) === show([...ids].sort()) && ids.includes('user:alice') && ids.includes('seat:robot') && list.find((p) => p.id === 'user:alice').identities.length === 2
      && list.every((p) => Array.isArray(p.identities)), '列表：全部主体按标识排序，各带自己的外部身份', show(ids));
  }

  // ---------- 七、迁移幂等，多个进程共用一个数据目录 ----------
  {
    const before = show(principals.list());
    const again = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', "await import(process.argv[1]); console.log('OPENED')", at('server/src/db.ts')], { env: { ...process.env, DATA_DIR: OUT }, encoding: 'utf8', timeout: 60000 });
    check(again.status === 0 && again.stdout.includes('OPENED') && show(principals.list()) === before, '再开一次库（旧库启动补表）：不报错，已有的主体原样还在', `status=${again.status} ${again.stderr.trim().slice(0, 200)}`);
  }
  {
    // 四个进程同时把同一批没见过的人各对一遍：每个人最后只有一个主体、一条外部身份，没有孤儿
    const logins = Array.from({ length: 12 }, (_, i) => `race-${i}`);
    /** 起一个子进程，等它开好库。返回 { go, done }：go() 发话开跑，done 是跑完的结果 */
    const start = () => new Promise((opened) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', WORKER, at('server/src/root-context.ts'), at('server/src/services/principal.ts'), JSON.stringify(logins)], { env: { ...process.env, DATA_DIR: OUT }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '', ready = false;
      const done = new Promise((finished) => child.on('close', (status) => { const m = /RESULT=(.*)/.exec(out); finished({ status, result: m ? JSON.parse(m[1]) : null, err }); if (!ready) opened({ go() {}, done }); }));
      child.stdout.on('data', (d) => { out += String(d); if (!ready && out.includes('OPENED')) { ready = true; opened({ go: () => child.stdin.end('go\n'), done }); } });
      child.stderr.on('data', (d) => { err += String(d); });
    });
    const started = [];
    for (let i = 0; i < 4; i++) started.push(await start()); // 一个一个开库
    for (const w of started) w.go(); // 一起开跑
    const workers = await Promise.all(started.map((w) => w.done));
    const answers = workers.flatMap((w) => (w.result ? Object.entries(w.result) : [['', 'worker failed']]));
    const allOk = workers.every((w) => w.status === 0 && w.result) && answers.every(([login, got]) => got === `user:${login}`);
    const rows = db.prepare("SELECT (SELECT COUNT(*) FROM principals WHERE id LIKE 'user:race-%') AS p, (SELECT COUNT(*) FROM principal_identities WHERE external_id LIKE 'race-%') AS i, (SELECT COUNT(*) FROM principals p WHERE p.id LIKE 'user:race-%' AND NOT EXISTS (SELECT 1 FROM principal_identities i WHERE i.principal_id = p.id)) AS orphan").get();
    check(allOk && rows.p === logins.length && rows.i === logins.length && rows.orphan === 0, `四个进程同时对同一批 ${logins.length} 个新人：每人一个主体、一条外部身份，没有只建了一半的`, `${show(rows)} ${show(answers.filter(([login, got]) => got !== `user:${login}`).slice(0, 4))} ${workers.map((w) => w.err.trim().slice(0, 120)).filter(Boolean).join(' | ')}`);
  }
  db.close();
} catch (e) {
  fail++;
  console.log(`  ✗ 单测没跑完：${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
console.log(`principal-service-test: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
