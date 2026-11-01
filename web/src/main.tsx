import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { installAdminTokenLeaveGuard, setAdminToken } from './admin-token';
import { surface } from './surface';
import { DESIGN_TOKENS as T } from './design-tokens';
import './tokens.css';
import './index.css';

dayjs.locale('zh-cn');
installAdminTokenLeaveGuard(); // #292 M4
if (surface === 'market') setAdminToken(''); // #292 M1：业务面不留口令（清掉 M1 之前留下的）

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfigProvider
        locale={zhCN}
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
