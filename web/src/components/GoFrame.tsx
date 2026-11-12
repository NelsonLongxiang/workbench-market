import { useState, useSyncExternalStore } from 'react';
import { Button, Empty, Result, Space } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { adminTokenPresent, setAdminToken, subscribeAdminToken } from '../admin-token';
import { MARKET_SELF_TEXT, isMarketDocument, pointsAtMarket } from '../embed-guard';

/** #292 M4 止血：/go/<id>/ 内嵌框。本标签页存着管理员口令时不嵌（同源 iframe 能读 sessionStorage、挂钩父页 fetch），
 *  改为新标签页（noopener）打开，或清除口令后再嵌。完整修复见 #292 M1（控制面单独 origin）。
 *  台的地址指向市场自己时不嵌（url 看登记的地址；嵌进来以后再看框里是不是市场自己的页面），说一句，免得市场套市场（embed-guard.ts）。 */
export default function GoFrame({ wid, name, frameKey, className, url, selfText = MARKET_SELF_TEXT }: { wid: number; name: string; frameKey?: number; className?: string; url?: string; selfText?: string }) {
  const hasToken = useSyncExternalStore(subscribeAdminToken, adminTokenPresent);
  const src = `/go/${wid}/`;
  const [selfLoaded, setSelfLoaded] = useState<number | null>(null);
  if (pointsAtMarket(url, window.location.origin) || selfLoaded === (frameKey ?? 0)) {
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
  return <iframe key={frameKey} className={className} src={src} title={name} allow="clipboard-read; clipboard-write; fullscreen"
    onLoad={(e) => { try { if (isMarketDocument(e.currentTarget.contentDocument)) setSelfLoaded(frameKey ?? 0); } catch { /* 别的来源读不到，不是市场自己 */ } }} />;
}
