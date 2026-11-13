/** 经验库（照产品化原型 3fbfd0b 的 #/knowledge）：从事项里沉淀下来的依据、经验、方法、检查。
 *  读接口还没有：页面照原型留顶上那一句，下面一张卡片说清楚现在没有、以后按哪四类出现；不列条目、不造数据。
 *  四类的名字和说法在 web/src/knowledge-view.ts（有单测）。 */
import type { ReactNode } from 'react';
import { Card, Empty, List, theme, Typography } from 'antd';
import { BookOutlined, BulbOutlined, CheckOutlined, SafetyOutlined } from '@ant-design/icons';
import WmPage from '../../components/WmPage';
import { KNOWLEDGE_EMPTY, KNOWLEDGE_INTRO, KNOWLEDGE_KINDS, type KnowledgeKind } from '../../knowledge-view';

const ICON: Record<KnowledgeKind, ReactNode> = { claim: <SafetyOutlined />, kb: <BookOutlined />, skill: <BulbOutlined />, verify: <CheckOutlined /> };

export default function Knowledge() {
  const { token } = theme.useToken();
  // 底色用设计档位（tokens.css）：antd 主题里的 colorSuccessBg 这类在本站是灰的，不合原型的浅底。紫色没有档位，用 antd 的紫色预设
  const tone = { success: ['var(--wm-color-success-bg)', 'var(--wm-color-success)'], info: ['var(--wm-color-info-bg)', 'var(--wm-color-info)'], purple: [token['purple-1'], token['purple-6']] } as const;
  return <WmPage>
    <div className="wm-reading">
      <Typography.Paragraph className="wm-page-intro" data-testid="kn-intro">{KNOWLEDGE_INTRO}</Typography.Paragraph>
      <Card data-testid="kn-empty">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={KNOWLEDGE_EMPTY} />
        <List size="small" dataSource={KNOWLEDGE_KINDS} rowKey="key" renderItem={(k) => (
          <List.Item data-testid="kn-kind" data-kind={k.key}>
            <List.Item.Meta
              avatar={<span aria-hidden="true" style={{ display: 'inline-grid', placeItems: 'center', width: token.controlHeight, height: token.controlHeight, borderRadius: token.borderRadius, background: tone[k.tone][0], color: tone[k.tone][1] }}>{ICON[k.key]}</span>}
              title={k.label}
              description={k.meaning} />
          </List.Item>
        )} />
      </Card>
    </div>
  </WmPage>;
}
