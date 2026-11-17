/** Test-only Vite entry. Not registered by App or the production router. */
import { createRoot } from 'react-dom/client';
import { P0Report } from './P0Report';
import type { FrozenReport } from './p0';
import '../tokens.css';
declare global { interface Window { __REPORT_P0__: FrozenReport; } }
const report = window.__REPORT_P0__;
if (!report || report.schema_version !== 1) throw new Error('missing_frozen_fixture');
createRoot(document.getElementById('root')!).render(<P0Report report={report} />);
