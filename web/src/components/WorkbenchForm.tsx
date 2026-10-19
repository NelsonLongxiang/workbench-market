import { useRef } from 'react';
import { ModalForm, ProFormDigit, ProFormSelect, ProFormSwitch, ProFormText, ProFormTextArea } from '@ant-design/pro-components';
import { api } from '../api';
import type { Workbench, WorkbenchType } from '../types';

export default function WorkbenchForm({
  open,
  types,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  types: WorkbenchType[];
  initial?: Workbench | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const formRef = useRef<any>();

  return (
    <ModalForm
      key={initial ? `edit-${initial.id}` : 'create'}
      title={initial ? `编辑工作台：${initial.name}` : '新增工作台'}
      width={560}
      open={open}
      onOpenChange={(v) => !v && onClose()}
      formRef={formRef}
      modalProps={{ destroyOnClose: true, maskClosable: false }}
      initialValues={
        initial ?? {
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
        }
      }
      onFinish={async (values) => {
        try {
          if (initial) await api.updateWorkbench(initial.id, values);
          else await api.createWorkbench(values);
          onSaved();
          return true;
        } catch (e) {
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
      <ProFormTextArea name="description" label="描述" placeholder="支持 Markdown；在工作台详情中渲染（可空）" />
    </ModalForm>
  );
}
