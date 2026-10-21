import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createApiClient } from './api/client';
import './theme/tokens.css';
import './theme/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('caipira explore: the page has no #root element');

createRoot(root).render(
  <StrictMode>
    <App api={createApiClient()} />
  </StrictMode>
);
