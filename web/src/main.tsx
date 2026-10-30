import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import App from './App';
import { installAdminTokenLeaveGuard } from './admin-token';
import './index.css';

dayjs.locale('zh-cn');
installAdminTokenLeaveGuard(); // #292 M4

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ConfigProvider
        locale={zhCN}
        theme={{
          token: {
            colorPrimary: '#1E3A5F',
            colorSuccess: '#059669',
            colorError: '#DC2626',
            colorInfo: '#1E3A5F',
            // 次级文字对比度：默认 rgba(0,0,0,.45) 在白底仅 3.36:1（WCAG AA 需 4.5:1），
            // #5A6577 在白底 5.9:1、在 #F6F7F9 约 5.5:1
            colorTextSecondary: '#5A6577',
            borderRadius: 6,
            fontFamily:
              "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
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
