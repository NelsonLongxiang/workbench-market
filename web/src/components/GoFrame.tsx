import { useSyncExternalStore } from 'react';
import { Button, Empty, Result, Space } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { adminTokenPresent, setAdminToken, subscribeAdminToken } from '../admin-token';
import { MARKET_SELF_TEXT, pointsAtMarket } from '../embed-guard';

/** #292 M4 止血：/go/<id>/ 内嵌框。本标签页存着管理员口令时不嵌（同源 iframe 能读 sessionStorage、挂钩父页 fetch），
 *  改为新标签页（noopener）打开，或清除口令后再嵌。完整修复见 #292 M1（控制面单独 origin）。
 *  台登记的地址指向市场自己时不嵌（url 看登记的地址），说一句，免得市场套市场（embed-guard.ts）。
 *  嵌进来以后才发现是市场自己的页面，由框里的市场页自己认出来、换成一句话（main.tsx 启动时看 framedByMarket）：
 *  框的属性只有 key/className/src/title/allow，不加事件、不加 ref（判据 65 和 scripts/portal-call-chain-test.mjs 守着）。 */
export default function GoFrame({ wid, name, frameKey, className, url, selfText = MARKET_SELF_TEXT }: { wid: number; name: string; frameKey?: number; className?: string; url?: string; selfText?: string }) {
  const hasToken = useSyncExternalStore(subscribeAdminToken, adminTokenPresent);
  const src = `/go/${wid}/`;
  if (pointsAtMarket(url, window.location.origin)) {
    return <Empty className="wm-go-guard" image={Empty.PRESENTED_IMAGE_SIMPLE} description={selfText} data-testid="go-self" />;
  }
  if (hasToken) {
    return (
      <Result
        className="wm-go-guard"
        status="warning"
        title="本标签页已设管理员口令，暂不内嵌工作台"
        subTitle="内嵌页面与市场同源，能读到本标签页里的口令。请在新标签页打开，或先清除口令再内嵌。"
        extra={(
          <Space wrap>
            <Button type="primary" icon={<ExportOutlined />} onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}>新标签页打开</Button>
            <Button onClick={() => setAdminToken('')}>清除口令并内嵌</Button>
          </Space>
        )}
      />
    );
  }
  return <iframe key={frameKey} className={className} src={src} title={name} allow="clipboard-read; clipboard-write; fullscreen" />;
}
