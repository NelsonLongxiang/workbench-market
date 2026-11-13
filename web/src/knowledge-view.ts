/** 经验库（照产品化原型 3fbfd0b 的 #/knowledge）的纯数据：四类条目叫什么、各是什么。
 *  经验库的读接口还没有：页面只说清楚这四类，不列条目、不造数据。接口到了以后，条目按这里的类别显示（类别名、图标、颜色同一处）。
 *  不引别的文件：scripts/knowledge-ui-unit.mjs 用 Node 直接加载。 */

export type KnowledgeKind = 'claim' | 'kb' | 'skill' | 'verify';

/** tone：图标底色用哪一档（antd 的 success / info / purple） */
export const KNOWLEDGE_KINDS: { key: KnowledgeKind; label: string; meaning: string; tone: 'success' | 'info' | 'purple' }[] = [
  { key: 'claim', label: '依据', meaning: '有原始记录、复核过的结论', tone: 'success' },
  { key: 'kb', label: '经验', meaning: '你拍过板的取舍，AI 员工以后照着办，不再问你', tone: 'info' },
  { key: 'skill', label: '方法', meaning: '反复用到的做法，整理成公司的标准方法', tone: 'purple' },
  { key: 'verify', label: '检查', meaning: '数据规范的检查结果，结果封存不改', tone: 'success' },
];

/** 页面顶上那一句（照原型） */
export const KNOWLEDGE_INTRO = '公司越用越聪明：你拍过板的取舍会记下来，下次 AI 员工照着办、不再问你；反复用到的做法会整理成公司的标准方法。';

/** 还没有接口时的说法：只说现在没有、以后从哪里来，不说在等哪个接口（那写在分支说明里） */
export const KNOWLEDGE_EMPTY = '经验库里还没有内容。以后从事项里沉淀下来的东西会按这四类出现在这里：';

/** 类别的名字：认不出的类别不露代号，写「其他」 */
export function kindLabel(kind: unknown): string {
  return KNOWLEDGE_KINDS.find((k) => k.key === kind)?.label ?? '其他';
}
