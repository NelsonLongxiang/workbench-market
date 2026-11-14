import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { installAdminTokenLeaveGuard } from './admin-token';
import { attentionChanged } from './api';
import { installIdentityWatch } from './identity-status';
import { installSessionWatch } from './session-watch';
import { clearShared } from './api';
import { DESIGN_TOKENS as T } from './design-tokens';
import './tokens.css';
import './index.css';
import { FRAMED_SELF_TEXT, framedByMarket } from './embed-guard';

dayjs.locale('zh-cn');
installAdminTokenLeaveGuard(); // #292 M4
installIdentityWatch(attentionChanged); // #639：身份服务连不上时挂提示、自动重试，连上后页面重读
installSessionWatch(clearShared); // 身份变了（没登录了、换了人）：清共用缓存，外壳按世代号重挂页面

// 被市场自己嵌在框里（台的地址落回了市场的页面）：不起整个市场，只写一句（embed-guard.ts 的第二层防护）
if (framedByMarket(window as unknown as Parameters<typeof framedByMarket>[0])) {
  ReactDOM.createRoot(document.getElementById('root')!).render(<div className="wm-framed-self" data-testid="framed-self">{FRAMED_SELF_TEXT}</div>);
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <BrowserRouter>
        <ConfigProvider
          locale={zhCN}
          // 两个字的按钮不在字中间插空格（「核准」不写成「核 准」）：全站一处设，页面里不再逐个关
          button={{ autoInsertSpace: false }}
          theme={{
            // #315：取值来自 DESIGN.md（经 scripts/gen-design-tokens.mjs 生成），这里只做 antd 名字映射
            token: {
              colorPrimary: T.colors.primary,
              colorSuccess: T.colors.success,
              colorError: T.colors.danger,
              colorInfo: T.colors.info,
              colorTextSecondary: T.colors['text-secondary'],
              borderRadius: parseInt(T.rounded.md, 10),
              fontFamily: T.typography['family-sans'],
            },
          }}
        >
          <AntApp>
            <App />
          </AntApp>
        </ConfigProvider>
      </BrowserRouter>
    </React.StrictMode>
  );
}
