/** Durable but non-blocking outcome of the LayerFS shadow publish. */
export type ShadowPublishResult = { commit_id: string } | null;

export function recordLayerFsShadowOutcome(db: any, slug: string, version: number, project: string, result: ShadowPublishResult): void {
  db.exec('BEGIN');
  try {
    if (result?.commit_id) {
      const v = db.prepare("UPDATE app_versions SET commit_id = ?, shadow_status = 'succeeded', shadow_error = '' WHERE app_id = (SELECT id FROM apps WHERE slug = ?) AND version = ? AND commit_id = ''").run(result.commit_id, slug, version);
      if (Number(v.changes) !== 1) throw new Error('shadow outcome version row missing or already committed');
      db.prepare("UPDATE apps SET layerfs_project = ? WHERE slug = ?").run(project, slug);
    } else {
      db.prepare("UPDATE app_versions SET shadow_status = 'failed', shadow_error = 'LayerFS publish failed; retry migrate-layerfs' WHERE app_id = (SELECT id FROM apps WHERE slug = ?) AND version = ? AND commit_id = ''").run(slug, version);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function recordLayerFsSkillShadowOutcome(db: any, skillId: number, version: number, result: ShadowPublishResult): void {
  db.exec('BEGIN');
  try {
    if (result?.commit_id) {
      const v = db.prepare("UPDATE skill_versions SET commit_id = ?, shadow_status = 'succeeded', shadow_error = '' WHERE skill_id = ? AND version = ? AND commit_id = ''").run(result.commit_id, skillId, version);
      if (Number(v.changes) !== 1) throw new Error('skill shadow outcome version missing or already committed');
    } else {
      db.prepare("UPDATE skill_versions SET shadow_status = 'failed', shadow_error = 'LayerFS publish failed; retry migrate-layerfs' WHERE skill_id = ? AND version = ? AND commit_id = ''").run(skillId, version);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
