import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import '@xyflow/react/dist/style.css';
import './styles/workbench.css';

createRoot(document.getElementById('root')!).render(<App />);
