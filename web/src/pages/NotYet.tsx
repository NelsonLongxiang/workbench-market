/** 还没有数据来源的入口：说清楚这一页要显示什么、在等哪项接口，不放假数据。
 *  导航按原型的结构先排好（全景、事项、团队、谁能做什么、经验库），接口到位一页换一页。 */
import { Link } from 'react-router-dom';
import { Empty, Typography } from 'antd';
import WmPage from '../components/WmPage';

export type NotYetSpec = { title: string; what: string; waiting: string; meanwhile?: { to: string; label: string }[] };

export const NOT_YET: Record<string, NotYetSpec> = {
  home: {
    title: '全景', what: '公司正在走的每条线、各走到哪一步、哪里等你拍板，以及在这里安排一件事。',
    waiting: '对象和阶段的读接口还没挂上；挂上之前这里先不画表。',
    meanwhile: [{ to: '/attention', label: '等你拍板的事' }, { to: '/overview', label: '原来的总览' }],
  },
  items: {
    title: '事项', what: '你建立的、经手的每一件事，按状态或按对象分组。',
    waiting: '事项列表接口还没合入。',
    meanwhile: [{ to: '/attention', label: '等你拍板的事' }, { to: '/tasks', label: '统一待办' }],
  },
  team: {
    title: '团队', what: '每个部门的负责人和 AI 员工：在办几件、验收通过率、工作方式、会做什么。',
    waiting: '部门和席位名册还没有接口。',
  },
  access: {
    title: '谁能做什么', what: '人和权限、角色预设、以某人的身份看；待你核准的授予。',
    waiting: '这一页在排期，授予、主体、角色的接口已经有了。',
    meanwhile: [{ to: '/attention', label: '待核的授予在「等你拍板」里' }],
  },
  knowledge: {
    title: '经验库', what: '从事项里沉淀下来的依据、经验、方法和检查。',
    waiting: '经验沉淀还没有接口。',
  },
};

export default function NotYet({ spec }: { spec: NotYetSpec }) {
  return <WmPage title={spec.title}>
    <Empty data-testid="not-yet" description={<>
      <Typography.Paragraph className="wm-m-0">{spec.what}</Typography.Paragraph>
      <Typography.Paragraph type="secondary" className="wm-m-0">{spec.waiting}</Typography.Paragraph>
    </>}>
      {spec.meanwhile && <Typography.Text type="secondary">现在可以先去：{spec.meanwhile.map((m, i) => <span key={m.to}>{i ? '、' : ''}<Link to={m.to}>{m.label}</Link></span>)}</Typography.Text>}
    </Empty>
  </WmPage>;
}
