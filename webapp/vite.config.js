// Files the agent creates that nothing imports yet (or that an Undo left in
// Vite's module graph) would otherwise trigger a full page reload. Skip them;
// the edit that imports them will hot-update the importer.
const skipOrphans = {
  name: 'skip-orphans',
  handleHotUpdate({ modules }) {
    // Web games (apps/<id>/) are their own pages: let their edits through (they reload the game).
    return modules.filter((m) => m.importers.size > 0 || m.url === '/src/main.js' || m.url.startsWith('/apps/'));
  },
};

// The kit (/kit/openhouse.js) comes from the bridge at run time, through the proxy: not something to bundle.
const kitOutside = { name: 'kit-outside', enforce: 'pre', resolveId(id) { if (id.startsWith('/kit/')) return { id, external: true }; } };

export default {
  plugins: [kitOutside, skipOrphans],
  // The display runs its own copy of this (device/vite.config.mjs). Apps reach the bridge through /bridge and the kit at /kit.
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true, hmr: { overlay: true },
    proxy: { '/bridge': { target: 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (p) => p.replace(/^\/bridge/, '') }, '/kit': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
  // Pre-bundle the game libraries at startup, so the first game doesn't wait (or reload) for it.
  optimizeDeps: {
    include: ['three', 'three/webgpu', 'three/tsl', 'phaser', '@dimforge/rapier2d-compat', '@dimforge/rapier3d-compat'],
  },
};
