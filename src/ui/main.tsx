import { createRoot } from 'react-dom/client';
import { App } from './App';
import { defineIcons } from './icons';

defineIcons();
createRoot(document.getElementById('root')!).render(<App />);
