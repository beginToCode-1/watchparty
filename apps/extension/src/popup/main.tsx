import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../content/sidebar/sidebar.css';
import { Popup } from './Popup';

const root = document.getElementById('wp-root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
