import { useRef, useState } from 'react';
import { App, Button, Space, Typography } from 'antd';
import { ModalForm, ProFormDigit, ProFormSelect, ProFormSwitch, ProFormText, ProFormTextArea } from '@ant-design/pro-components';
import { api } from '../api';
import type { Workbench, WorkbenchType } from '../types';

interface CookieSetInfo {
  id: number; label: string; cookie_count: number; active: number;
  all_expired: boolean; soonest_exp_days: number | null; created_at: string;
}

export default function WorkbenchForm({
  open,
  types,
  initial,
  copySource,
  onClose,
  onSaved,
}: {
  open: boolean;
  types: WorkbenchType[];
  /** 编辑目标（有 id） */
  initial?: Workbench | null;
  /** 复制来源：预填其全部字段，名称加 (副本)，按新增提交 */
  copySource?: Workbench | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formRef = useRef<any>();
  const { message } = App.useApp();
  const [cookieSets, setCookieSets] = useState<CookieSetInfo[]>([]);
  const [cookieJson, setCookieJson] = useState('');

  // 表单打开时拉 cookie 池列表（轻量）
  const loadCookieSets = () => {
    fetch('/api/cookies')
      .then((r) => (r.ok ? r.json() : []))
      .then(setCookieSets)
      .catch(() => setCookieSets([]));
  };

  const importCookies = async () => {
    if (!cookieJson.trim()) return;
    try {
      const arr = JSON.parse(cookieJson);
      if (!Array.isArray(arr)) throw new Error('不是 JSON 数组');
      const label = `导入 ${new Date().toLocaleTimeString()}`;
      const r = await fetch('/api/cookies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, cookies: arr }),
      });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error || `HTTP ${r.status}`);
      message.success(`已导入 ${b.cookie_count} 条 cookie（${b.active} 条有效）`);
      setCookieJson('');
      loadCookieSets();
    } catch (e) {
      message.error(`导入失败：请粘贴 Cookie-Editor 导出的 JSON 数组——${(e as Error).message}`);
    }
  };

  const copyInitial = copySource
    ? {
        name: `${copySource.name} (副本)`,
        url: copySource.url,
        type: copySource.type,
        icon: copySource.icon || '',
        category: copySource.category || '',
        tags: copySource.tags ?? [],
        health_path: copySource.health_path || '',
        enabled: copySource.enabled,
        sort: copySource.sort ?? 0,
        description: copySource.description || '',
        authType: copySource.auth?.type ?? 'none',
        authValue: copySource.auth?.value ?? '',
      }
    : null;

  return (
    <ModalForm
      key={initial ? `edit-${initial.id}` : copySource ? `copy-${copySource.id}-${copySource.name}` : 'create'}
      title={initial ? `编辑工作台：${initial.name}` : copySource ? `复制工作台：${copySource.name}` : '新增工作台'}
      width={560}
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); else loadCookieSets(); }}
      formRef={formRef}
      modalProps={{ destroyOnClose: true, maskClosable: false }}
      initialValues={
        initial
          ? {
              ...initial,
              authType: initial.auth?.type ?? 'none',
              authValue: initial.auth?.value ?? '',
            }
          : copyInitial ?? {
              name: '',
              url: '',
              type: 'web',
              icon: '',
              category: '',
              tags: [],
              health_path: '',
              enabled: true,
              sort: 0,
              description: '',
              authType: 'none',
              authValue: '',
            }
      }
      onFinish={async (values) => {
        try {
          const { authType, authValue, _cookieImport, ...payload } = values;
          // 凭据注入：none → 清除；bearer/basic → 组装 auth（服务端经 /go/ 门户注入 Authorization 头）
          (payload as Record<string, unknown>).auth =
            authType === 'bearer' || authType === 'basic' ? { type: authType, value: authValue } : null;
          // cookie_set_id：undefined/'' → 0 取消挂接；数字 → 挂接
          (payload as Record<string, unknown>).cookie_set_id = Number(values.cookie_set_id) || 0;
          if (initial) await api.updateWorkbench(initial.id, payload);
          else await api.createWorkbench(payload);
          onSaved();
          return true;
        } catch (e) {
          message.error(`保存失败：${(e as Error).message}`);
          return false;
        }
      }}
      submitter={{ searchConfig: { submitText: initial ? '保存' : '创建', resetText: '取消' } }}
    >
      <ProFormText
        name="name"
        label="名称"
        rules={[{ required: true, message: '请输入名称' }, { max: 40, message: '最长 40 字' }]}
        placeholder="例如：本地 Ollama 服务"
      />
      <ProFormText
        name="url"
        label="服务地址"
        rules={[
          { required: true, message: '请输入服务地址' },
          { pattern: /^https?:\/\/.+/, message: '必须以 http:// 或 https:// 开头' },
        ]}
        placeholder="http://127.0.0.1:7860"
      />
      <ProFormSelect
        name="type"
        label="类型"
        showSearch
        options={types.map((t) => ({
          value: t.key,
          label: `${t.icon || '▢'} ${t.name}（${t.key}）`,
        }))}
        extra="类型的探测语义决定健康检查方式（见类型管理）"
        fieldProps={{
          onChange: (key: string) => {
            const t = types.find((x) => x.key === key);
            const cur: string = formRef.current?.getFieldValue('url') ?? '';
            if (t?.default_port && (!cur || /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(cur))) {
              formRef.current?.setFieldValue('url', `http://127.0.0.1:${t.default_port}`);
            }
          },
        }}
      />
      <ProFormText name="icon" label="图标" width="xs" placeholder="🤖（可空）" />
      <ProFormText name="category" label="分类" placeholder="例如：AI / 数据 / 运维（可空）" />
      <ProFormSelect name="tags" label="标签" fieldProps={{ mode: 'tags', tokenSeparators: [',', ' '] }} placeholder="回车添加，可多个" />
      <ProFormText
        name="health_path"
        label="探测路径"
        placeholder="留空 = 使用类型默认探测路径"
        extra="支持完整 URL 或相对路径，覆盖类型默认值"
      />
      <ProFormSwitch name="enabled" label="启用" />
      <ProFormDigit name="sort" label="排序" width="xs" min={0} extra="小的靠前" />
      <ProFormSelect
        name="authType"
        label="凭据注入"
        options={[
          { value: 'none', label: '无' },
          { value: 'bearer', label: 'Bearer Token' },
          { value: 'basic', label: 'Basic（用户名:密码）' },
        ]}
        extra="经统一门户 /go/ 访问时自动携带 Authorization 头，token 不必再拼进地址（token-in-url 会泄漏进上游日志）"
      />
      <ProFormText
        name="authValue"
        label="凭据值"
        width="md"
        placeholder="Bearer 填 token；Basic 填 用户名:密码"
        fieldProps={{ autoComplete: 'off' }}
      />
      <ProFormSelect
        name="cookie_set_id"
        label="Cookie 集"
        allowClear
        options={cookieSets.map((c) => ({
          value: c.id,
          label: c.all_expired ? `${c.label}（${c.cookie_count} 条·已全过期）` :
            c.soonest_exp_days !== null && c.soonest_exp_days <= 7 ? `${c.label}（${c.active}/${c.cookie_count} 条·剩 ${c.soonest_exp_days} 天）` :
            `${c.label}（${c.active}/${c.cookie_count} 条有效）`,
        }))}
        extra="选择后经 /go/ 门户访问时自动注入该 cookie 集（按目标域匹配+未过期过滤）；不选 = 浏览器透传"
        fieldProps={{ placeholder: '不挂接 cookie（浏览器透传）' }}
      />
      <div style={{ marginBottom: 4 }}>
        <Typography.Text style={{ fontSize: 13 }}>快速导入 Cookie</Typography.Text>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }}>
          粘贴 Cookie-Editor / EditThisCookie 导出的 JSON 数组，点导入即可建池
        </Typography.Paragraph>
        <textarea
          className="wm-mono"
          style={{ width: '100%', padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 12, minHeight: 44, resize: 'vertical' }}
          placeholder='[{"name":"session","value":"...","domain":"..."}]'
          value={cookieJson}
          onChange={(e) => setCookieJson(e.target.value)}
        />
      </div>
      <Button size="small" onClick={importCookies} disabled={!cookieJson.trim()} style={{ marginBottom: 16 }}>
        导入为 Cookie 集
      </Button>
      <ProFormTextArea name="description" label="描述" placeholder="支持 Markdown；在工作台详情中渲染（可空）" />
    </ModalForm>
  );
}
