import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('index.html must contain <div id="root">; the bundle has nowhere to mount.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
