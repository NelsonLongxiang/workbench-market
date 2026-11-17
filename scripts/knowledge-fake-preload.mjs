/**
 * 录制回放用的夹具（--import 预加载）：经验库（/api/knowledge）的来源换成假的 ygl-trees 命令行（scripts/fixtures/ygl-library-fake.mjs）。
 *   · 临时目录里放一个工作区（YGL_HOME 指过去），里面是固定的 library-fixture.json；WM_YGL_CLI 指到假命令行；
 *   · 后台同步关掉（WM_KNOWLEDGE_SYNC_MINUTES=0）：目录由场景的 seed 直接写进库，每次的应答都一样；详情照常现调假命令行取正文。
 * 所有东西都是合成的。临时目录在进程退出时删掉。
 *
 * 只在测试环境里装得上（NODE_ENV=test）：scripts/ 会随镜像一起发出去，不能在别的环境里把经验库的来源指到假的上。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'test') {
  console.error('[knowledge-fake-preload] 拒绝加载：只在 NODE_ENV=test 下可用');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'wm-knowledge-fake-'));
process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* 退出时尽力而为 */ } });

const T = '2030-01-01T00:00:00Z';
writeFileSync(join(root, 'library-fixture.json'), JSON.stringify({
  items: {
    note: [
      { kind: 'note', id: 'replay-star', title: '回放经验：全公司', summary: '人人可见', scope: '*', created: T, updated: T },
      { kind: 'note', id: 'replay-sales', title: '回放经验：销售部', summary: '销售部可见', scope: 'dept:sales', created: T, updated: T },
      { kind: 'note', id: 'replay-restricted', title: '回放经验：只给管理层', summary: '', scope: 'restricted', created: T, updated: T },
    ],
  },
  bodies: { 'note:replay-star': { body: '# 回放正文\n以后照这样办。' } },
}));
process.env.YGL_HOME = root;
process.env.WM_YGL_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ygl-library-fake.mjs');
process.env.WM_KNOWLEDGE_SYNC_MINUTES = '0';
