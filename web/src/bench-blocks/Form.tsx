/**
 * 表单：按列定义出输入框——文本、整数、小数、日期、时间、是否。提交交给调用方（onSubmit），成功后清空。
 * 只提交表单里列出的字段；没填的不带（留空）。
 */
import { useState } from 'react';
import { Alert, Button, DatePicker, Form, Input, InputNumber, Switch } from 'antd';
import type { Dayjs } from 'dayjs';
import { BlockFrame, type BlockFrameProps } from './Frame';
import { errorText, type BlockColType, type BlockError } from './blocks-view';

export type FormField = { name: string; type: BlockColType; label?: string; required?: boolean };
export interface FormBlockProps extends Omit<BlockFrameProps, 'data' | 'empty'> {
  fields: FormField[];
  submitLabel?: string;
  /** 提交；失败就抛 { code, message }，这里按出错的说法显示 */
  onSubmit: (values: Record<string, unknown>) => Promise<unknown>;
  /** 现在不能提交的原因（比如没有权限）：按钮不可点，并把原因写在旁边 */
  disabledReason?: string;
}

export function FormBlock({ fields, submitLabel = '提交', onSubmit, disabledReason, span = 6, ...frame }: FormBlockProps) {
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<BlockError | null>(null);
  const submit = async (raw: Record<string, unknown>) => {
    const values: Record<string, unknown> = {};
    for (const f of fields) {
      const v = raw[f.name];
      if (v === undefined || v === null || v === '') continue;
      values[f.name] = f.type === 'date' ? (v as Dayjs).format('YYYY-MM-DD') : f.type === 'datetime' ? (v as Dayjs).toISOString() : v;
    }
    setBusy(true); setErr(null); setDone(false);
    try { await onSubmit(values); form.resetFields(); setDone(true); } catch (e) {
      const b = e as Partial<BlockError> | null;
      setErr({ code: typeof b?.code === 'string' ? b.code : 'unknown', message: typeof b?.message === 'string' ? b.message : undefined });
    } finally { setBusy(false); }
  };
  return (
    <BlockFrame {...frame} span={span} kind="form" skipEmpty>
      <Form form={form} layout="vertical" requiredMark="optional" onFinish={submit} disabled={busy || !!disabledReason} className="wm-bb-form">
        {fields.map((f) => (
          <Form.Item
            key={f.name} name={f.name} label={f.label || f.name} valuePropName={f.type === 'boolean' ? 'checked' : 'value'}
            rules={f.required ? [{ required: true, message: `请填${f.label || f.name}` }] : undefined}
          >
            {f.type === 'integer' ? <InputNumber precision={0} className="wm-bb-form-wide" />
              : f.type === 'decimal' ? <InputNumber className="wm-bb-form-wide" />
                : f.type === 'date' ? <DatePicker className="wm-bb-form-wide" />
                  : f.type === 'datetime' ? <DatePicker showTime className="wm-bb-form-wide" />
                    : f.type === 'boolean' ? <Switch />
                      : <Input.TextArea autoSize={{ minRows: 1, maxRows: 6 }} maxLength={10000} />}
          </Form.Item>
        ))}
        {err ? <Alert type="warning" showIcon className="wm-bb-form-msg" message={err.code === 'invalid' && err.message ? `没交上去：${err.message}` : err.code === 'conflict' ? '这个页面过期了，刷新之后再提交。' : err.code === 'forbidden' ? '没交上去：你的账号不能在这个台上填表。要填的话，请管理层为你开通这个台的权限。' : errorText(err)} /> : null}
        {done ? <Alert type="success" showIcon className="wm-bb-form-msg" message="已经交上去了。" /> : null}
        <div className="wm-bb-form-foot">
          <Button type="primary" htmlType="submit" loading={busy}>{submitLabel}</Button>
          {disabledReason ? <span className="wm-bb-form-why">{disabledReason}</span> : null}
        </div>
      </Form>
    </BlockFrame>
  );
}
