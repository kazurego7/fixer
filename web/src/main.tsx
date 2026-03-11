import React from 'react';
import { createRoot } from 'react-dom/client';
import Framework7 from 'framework7/lite-bundle';
import Framework7React from 'framework7-react';
import 'framework7/css/bundle';
import './styles.css';
import AppRoot from './App';

Framework7.use(Framework7React);

const root = document.getElementById('root');
if (!root) throw new Error('root_element_missing');

createRoot(root).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
