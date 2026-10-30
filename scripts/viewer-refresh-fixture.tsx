import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ViewerChip from '../web/src/components/ViewerChip';
import { useOdooPopupLogin } from '../web/src/pages/odoo-login';
function Fixture() {
  const [done, setDone] = useState(0);
  const login = useOdooPopupLogin('/login', () => setDone(n => n + 1));
  return <><ViewerChip /><button onClick={login.open}>Page login</button><span data-testid="done">{done}</span></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
