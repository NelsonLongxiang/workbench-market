/** 用户卡里的「我的助理」入口：照「改密码」的做法，满足条件才出——
 *  GET /api/assistant 回 200、并且部署方开放了助理（enabled_by_deployment 为真）。
 *  没登录、管理员口令或令牌（不是本人的会话）、服务端还没有助理接口（404）、没开放、出错，都不出。判定在 assistant-view.ts 的 showEntry。 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RobotOutlined } from '@ant-design/icons';
import { getAssistant } from '../api';
import { showEntry } from '../assistant-view';

export default function AssistantLink() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    void getAssistant().then((r) => { if (live) setShow(showEntry(r.status, r.body)); });
    return () => { live = false; };
  }, []);
  if (!show) return null;
  return <Link to="/settings/assistant" className="wm-me-link" data-testid="me-assistant"><RobotOutlined /> 我的助理</Link>;
}
