/** 「记成经验」那三项：以后遇到类似情况怎么办（必填）、这件事是什么情况（选填，空着用条目标题）、谁能看（缺省按服务端推的那一档）。
 *  答复卡上的勾选和「我处理过的」补记用同一份。竖着排，驾驶舱右栏窄也放得下。说法和判断在 web/src/remember-view.ts。 */
import { Input, Radio, Space, Typography } from 'antd';
import { CUE_LABEL, CUE_MAX, LESSON_LABEL, LESSON_MAX, visibilityOptions, type RememberDefaults, type Visibility } from '../remember-view';

export default function RememberFields({ defaults, lesson, cue, visibility, onLesson, onCue, onVisibility, cuePlaceholder }: {
  defaults: RememberDefaults | null; lesson: string; cue: string; visibility: Visibility | null;
  onLesson: (v: string) => void; onCue: (v: string) => void; onVisibility: (v: Visibility) => void; cuePlaceholder?: string;
}) {
  return <Space direction="vertical" size={8} className="wm-w-full wm-remember" data-testid="remember-fields">
    <div>
      <Typography.Text className="wm-caption wm-remember-label">{LESSON_LABEL}</Typography.Text>
      <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={LESSON_MAX} showCount value={lesson} onChange={(e) => onLesson(e.target.value)}
        placeholder="比如：第一次检验不过，先退回供应商整改，不直接换供应商" data-testid="remember-lesson" aria-label={LESSON_LABEL} />
    </div>
    <div>
      <Typography.Text className="wm-caption wm-remember-label">{CUE_LABEL}（选填）</Typography.Text>
      <Input maxLength={CUE_MAX} value={cue} onChange={(e) => onCue(e.target.value)} placeholder={cuePlaceholder || '空着就用这件事的标题'} data-testid="remember-cue" aria-label={CUE_LABEL} />
    </div>
    <div>
      <Typography.Text className="wm-caption wm-remember-label">谁能看</Typography.Text>
      {defaults
        ? <Radio.Group value={visibility ?? defaults.default_visibility} onChange={(e) => onVisibility(e.target.value as Visibility)} data-testid="remember-visibility"
            options={visibilityOptions(defaults).map((o) => ({ value: o.value, label: o.label, disabled: o.disabled }))} />
        : <Typography.Text type="secondary" className="wm-caption" data-testid="remember-visibility-loading">正在看这件事归哪个部门……</Typography.Text>}
    </div>
  </Space>;
}
