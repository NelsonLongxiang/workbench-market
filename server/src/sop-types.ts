/** SOP 清单类型（S3 抽离共享）：sop.yaml 的结构化字段 + 步骤内嵌 HTML。 */
export interface SopStep { key: string; title: string; body?: string }
export interface SopManifest { title: string; code?: string; description?: string; steps: SopStep[] }
