/** 表格行操作（PATTERNS.md §5）：最多 2 个直接操作，其余收进「更多」下拉。
 *  危险项（删除、吊销、废弃）点了先弹确认框——下拉菜单里放 Popconfirm 会随菜单关闭而消失，所以统一走 modal.confirm。 */
import type { ReactNode } from 'react';
import { App, Button, Dropdown, Space } from 'antd';
import { MoreOutlined } from '@ant-design/icons';

export interface MoreAction {
  key: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** 给了就先确认再执行 */
  confirm?: { title: string; content?: ReactNode; okText?: string };
  onClick: () => void | Promise<void>;
}

export default function RowActions({ primary, more = [] }: { primary: ReactNode[]; more?: MoreAction[] }) {
  const { modal } = App.useApp();
  if (primary.length > 2) console.warn('RowActions：直接操作最多 2 个（PATTERNS.md §5），其余放 more');
  const items = more.map((m) => ({ key: m.key, label: m.label, icon: m.icon, danger: m.danger, disabled: m.disabled }));
  const onMenu = ({ key, domEvent }: { key: string; domEvent: { stopPropagation: () => void } }) => {
    domEvent.stopPropagation();
    const m = more.find((x) => x.key === key);
    if (!m) return;
    if (m.confirm) {
      modal.confirm({ title: m.confirm.title, content: m.confirm.content, okText: m.confirm.okText, okButtonProps: { danger: m.danger }, onOk: () => m.onClick() });
    } else void m.onClick();
  };
  return (
    <Space size={4} onClick={(e) => e.stopPropagation()}>
      {primary}
      {more.length > 0 && (
        <Dropdown trigger={['click']} menu={{ items, onClick: onMenu }}>
          <Button size="small" type="text" icon={<MoreOutlined />} aria-label="更多操作" />
        </Dropdown>
      )}
    </Space>
  );
}
