// Entry point. Accepts hot updates of the layout tree so edits to any widget
// re-render in place instead of reloading the page.
import './style.css';
import './theme.css';
import './presets.css';
import { render } from './layout.js';

const root = document.getElementById('app');
render(root);
window.__uiReady = true; // the shell's watchdog checks this

if (import.meta.hot) {
  import.meta.hot.accept('./layout.js', (mod) => {
    if (mod) mod.render(root);
  });
}
