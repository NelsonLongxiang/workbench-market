/** 单个技能的页面（/market/skill/:slug）：市场里技能卡片的「查看」进来。样子照工作台的详情页。
 *  上面：名字、哪一层、族、「旧版」、现在第几版、说明；下面：历次版本（版本号、改了什么、是不是不兼容、多大、谁审的、什么时候）。
 *  技能的标识（slug）、摘要（digest）、快照路径这类内部的东西不写在页面的字上。
 *  上一版的「技能市场」总表（/skills，按层分类）属主 2026-11-14 定了删掉：那只是 demo，没有用于生产。判断和说法在 web/src/market-view.ts。 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Empty, Flex, Skeleton, Space, Tag, Timeline, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import './market.css';
import WmPage from '../../components/WmPage';
import RelTime from '../../components/RelTime';
import { getMarketSkills, getMarketSkillVersions } from '../../api';
import { NO_DESCRIPTION, initialOf, sizeLabel, skillOf, skillProblem, skillVersionsOf, type SkillRow, type SkillVersion } from '../../market-view';

type State = { phase: 'loading' } | { phase: 'ok'; k: SkillRow; versions: SkillVersion[] | null } | { phase: 'problem'; kind: 'gone' | 'login' | 'denied' | 'error'; text: string };

export default function SkillDetail() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const [s, setS] = useState<State>({ phase: 'loading' });

  const load = useCallback(async () => {
    setS({ phase: 'loading' });
    const r = await getMarketSkills();
    const p = skillProblem(r.status);
    if (p) { setS({ phase: 'problem', ...p }); return; }
    const k = skillOf(r.body, slug);
    if (!k) { setS({ phase: 'problem', ...skillProblem(404)! }); return; }
    setS({ phase: 'ok', k, versions: null });
    // 版本读不到不影响上面那块：版本那一块自己说读不到
    const v = await getMarketSkillVersions(slug);
    setS({ phase: 'ok', k, versions: v.status === 200 ? skillVersionsOf(v.body) : [] });
  }, [slug]);
  useEffect(() => { void load(); }, [load]);

  const k = s.phase === 'ok' ? s.k : null;
  const name = k ? String(k.name || '这个技能') : '技能';
  const tags = k ? [k.family_parent, k.legacy ? '旧版' : ''].filter((t): t is string => typeof t === 'string' && t.trim() !== '') : [];
  return <WmPage title={name} detail={name} onBack={() => navigate('/market?k=技能')}>
    <div className="wm-reading">
      {s.phase === 'loading' && <Card><Skeleton active avatar paragraph={{ rows: 3 }} /></Card>}
      {s.phase === 'problem' && <Card data-testid="skd-problem" data-kind={s.kind}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={s.text}>
          <Space>
            {s.kind === 'error' && <Button icon={<ReloadOutlined />} onClick={() => void load()}>再试一次</Button>}
            <Link to="/market?k=技能">回到工作台市场</Link>
          </Space>
        </Empty>
      </Card>}
      {k && s.phase === 'ok' && <Flex vertical gap="middle">
        <Card data-testid="skd-main">
          <Flex vertical gap="middle">
            <div className="wm-wbd-head">
              <span className="wm-mkt-ic wm-mkt-ic-initial" aria-hidden>{initialOf(name)}</span>
              <div>
                <h2 className="wm-wbd-name" data-testid="skd-name">{name}</h2>
                <Space size={6} className="wm-wbd-sub" wrap>
                  {String(k.layer_name ?? '').trim() && <span data-testid="skd-layer">{String(k.layer_name).trim()}</span>}
                  {k.active_version != null && <Tag color="blue" data-testid="skd-current">现在是第 {k.active_version} 版</Tag>}
                  <span>共 {Number(k.versions) || 0} 个版本</span>
                </Space>
              </div>
            </div>
            {String(k.description ?? '').trim()
              ? <Typography.Paragraph className="wm-wbd-desc wm-m-0" data-testid="skd-desc">{String(k.description).trim()}</Typography.Paragraph>
              : <Typography.Text type="secondary" data-testid="skd-desc">{NO_DESCRIPTION}</Typography.Text>}
            {tags.length > 0 && <div className="wm-mkt-tags" data-testid="skd-tags">{tags.map((t) => <span key={t} className="wm-mkt-tag">{t}</span>)}</div>}
          </Flex>
        </Card>
        <Card size="small" title="历次版本" data-testid="skd-versions">
          {s.versions === null ? <Skeleton active title={false} paragraph={{ rows: 3 }} />
            : s.versions.length === 0 ? <Typography.Text type="secondary">读不到版本记录，稍后再试。</Typography.Text>
              : <Timeline items={s.versions.map((v) => ({
                color: v.breaking ? 'red' : v.active ? 'blue' : 'gray',
                children: <div data-testid="skd-version">
                  <Space size={8} wrap>
                    <Typography.Text strong>第 {v.version} 版</Typography.Text>
                    {v.active && <Tag color="blue">现在用的</Tag>}
                    {v.breaking && <Tag color="red">和上一版不兼容</Tag>}
                    {v.at && <RelTime value={v.at} />}
                  </Space>
                  <Typography.Paragraph className="wm-m-0" style={{ marginTop: 4 }}>{v.changelog || '没写改了什么'}</Typography.Paragraph>
                  <Typography.Text type="secondary" className="wm-caption">
                    {[v.files > 0 ? `${v.files} 个文件` : '', sizeLabel(v.bytes), v.reviewer ? `${v.reviewer} 审过` : ''].filter(Boolean).join(' · ')}
                  </Typography.Text>
                </div>,
              }))} />}
        </Card>
        <Typography.Text type="secondary" className="wm-caption" data-testid="skd-howto">技能由 AI 员工按需装上用；发布新版本走命令行，这里只看。</Typography.Text>
      </Flex>}
    </div>
  </WmPage>;
}
