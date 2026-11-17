/**
 * #183（单一事实源）+ #810：技能快照的磁盘相对路径——服务端发布和两个导入脚本（scripts/skill-import.mjs、
 * scripts/skill-upload-one.mjs）写快照都用这一个函数，读时按库里存的 snapshot_path。
 * 唯一形 = `skill-snapshots/<encodeURIComponent(全 slug)>/v<n>`：agents:x 和 dsh:x 各有各的目录，互不覆盖。
 * 存进 snapshot_path 的也是这个相对形（相对 DATA_DIR），服务端的 resolveSnap 认它。导出包里的顶层目录名仍用 name，不归这里管。
 */
export function skillSnapRel(slug: string, version: number): string {
  return 'skill-snapshots/' + encodeURIComponent(String(slug)) + '/v' + version;
}
