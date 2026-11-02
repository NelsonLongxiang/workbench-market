import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { TasksView } from '../web/src/pages/Tasks';
import { setAdminToken } from '../web/src/admin-token';
function Fixture() { return <ConfigProvider><button onClick={() => setAdminToken('synthetic-admin')}>test admin</button><button onClick={() => setAdminToken('')}>test clear</button><TasksView /></ConfigProvider>; }
createRoot(document.getElementById('root')!).render(<Fixture />);
