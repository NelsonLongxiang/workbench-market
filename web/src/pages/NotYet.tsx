/** 还没做好的入口：只对人说这里以后能做什么、现在可以先去哪里。在等哪项接口写在 PR 描述和差距清单里，不写在页面上。 */
import { Link } from 'react-router-dom';
import { Empty, Typography } from 'antd';
import WmPage from '../components/WmPage';

export type NotYetSpec = { title: string; what: string; meanwhile?: { to: string; label: string }[] };

export const NOT_YET: Record<string, NotYetSpec> = {
  items: {
    title: '事项', what: '你建立的、经手的每一件事，按状态或按对象分组。',
    meanwhile: [{ to: '/attention', label: '等你拍板的事' }],
  },
  team: {
    title: '团队', what: '每个部门的负责人和 AI 员工：在办几件、验收通过率、工作方式、会做什么。',
  },
  access: {
    title: '谁能做什么', what: '人和权限、角色预设、以某人的身份看；待你核准的授予。',
    meanwhile: [{ to: '/attention', label: '等你拍板的事' }],
  },
};

export default function NotYet({ spec }: { spec: NotYetSpec }) {
  return <WmPage title={spec.title}>
    <Empty data-testid="not-yet" description={<>
      <Typography.Paragraph className="wm-m-0">{spec.what}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="wm-m-0">这一页还在做。</Typography.Paragraph>
    </>}>
      {spec.meanwhile && <Typography.Text type="secondary">现在可以先去：{spec.meanwhile.map((m, i) => <span key={m.to}>{i ? '、' : ''}<Link to={m.to}>{m.label}</Link></span>)}</Typography.Text>}
    </Empty>
  </WmPage>;
}
