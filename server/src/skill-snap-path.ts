/**
 * #183（单一事实源）+ #810：技能快照的磁盘相对路径——服务端发布和两个导入脚本（scripts/skill-import.mjs、
 * scripts/skill-upload-one.mjs）写快照都用这一个函数，读时按库里存的 snapshot_path。
 * 唯一形 = `skill-snapshots/<encodeURIComponent(全 slug)>/v<n>`：agents:x 和 dsh:x 各有各的目录，互不覆盖。
 * 存进 snapshot_path 的也是这个相对形（相对 DATA_DIR），服务端的 resolveSnap 认它。导出包里的顶层目录名仍用 name，不归这里管。
 */
export function skillSnapRel(slug: string, version: number): string {
  if (!skillSnapSafe(slug)) throw new Error(`skill_slug_unsafe_for_snapshot ${JSON.stringify(String(slug))}`);
  return 'skill-snapshots/' + encodeURIComponent(String(slug)) + '/v' + version;
}

/**
 * 这个 slug 能不能当快照目录名：encodeURIComponent 不编码「.」，名字里有连续的点（a..b）时目录段里就有「..」，
 * 服务端 resolveSnap 对相对路径里的「..」一律当越界、读成 _blocked_（导出 404）——写进去就再也读不出来。
 * 读的一侧不放宽：写快照的入口（服务端发布、两个导入脚本）在写之前问它，不安全就拒收；skillSnapRel 自己也拒，兜底。
 */
export function skillSnapSafe(slug: string): boolean {
  const seg = encodeURIComponent(String(slug));
  return seg !== '' && !seg.includes('..');
}
