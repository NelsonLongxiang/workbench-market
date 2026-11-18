import React from 'react';
import { createRoot } from 'react-dom/client';
import ViewerChip from '../web/src/components/ViewerChip';
// 只渲染真实的 ViewerChip：/api/auth/viewer 由 scripts/viewer-refresh-browser.py 打桩
createRoot(document.getElementById('root')!).render(<ViewerChip />);
