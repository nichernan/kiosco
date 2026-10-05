import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
import './pos.css';
import './controls.css';
import './extra.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
