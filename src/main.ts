/// <reference types="vite-plugin-pwa/vanillajs" />
// The standalone app's entry (index.html): the editor, plus the service
// worker that keeps it working offline and brings in newer builds. The
// embeddable library (src/index.ts) has no service worker.
import './index.ts';
import { registerSW } from 'virtual:pwa-register';
import type { DrawingApp } from './components/drawing-app.ts';

/** How often an open window asks whether a newer build was published. */
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

// With registerType 'autoUpdate', a newer service worker takes over at once
// (skipWaiting/clientsClaim), whether this window or another found it; this
// window still runs the build it loaded. Without onNeedReload the plugin
// would reload the page there and then, unsaved work or not: the editor
// instead reloads when nothing would be lost, or offers it.
registerSW({
  immediate: true,
  onNeedReload() {
    document.querySelector<DrawingApp>('drawing-app')?.updateReady();
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    // A window left open for days would otherwise only look for an update
    // when it is next navigated.
    const check = () => {
      if (navigator.onLine === false) return;
      registration.update().catch(() => undefined);
    };
    setInterval(check, UPDATE_CHECK_INTERVAL);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  },
});
