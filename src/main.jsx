/*
 * AOS ACCELERATION CHAMBER
 * One operating surface for missions, swarms, evidence, evolution and system control.
 * Cobalt carries active work; void carries inspection; ultraviolet marks transitions;
 * ion marks verified state; vermilion is reserved for conflict and consequence.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { DemoProvider } from './app/DemoContext';
import { WorkspaceProvider } from './app/WorkspaceContext';
import './styles/tokens.css';
import './styles/base.css';
import './styles/system.css';
import './styles/chamber.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <WorkspaceProvider>
      <DemoProvider>
        <App />
      </DemoProvider>
    </WorkspaceProvider>
  </React.StrictMode>,
);
