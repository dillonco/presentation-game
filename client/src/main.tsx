import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { keepAppOffline } from './net/offline.js';
import './theme/tokens.css';

keepAppOffline();

// A page still open from before a release asks for screens whose files are gone. Loading the
// page again brings the new release. Once a minute at most, so no signal can't cause a loop.
const RELOADED_KEY = 'tp:reloadedForRelease';
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) ?? 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// Each audience downloads only its own screens, so phones stay light.
const GuestApp = lazy(() => import('./guest/GuestApp.js'));
const HostApp = lazy(() => import('./host/HostApp.js'));
const AdminApp = lazy(() => import('./admin/AdminApp.js'));
const StyleGuide = lazy(() => import('./StyleGuide.js'));
const Home = lazy(() => import('./Home.js'));

const path = window.location.pathname;
const guestRoom = path.match(/^\/j\/([A-Za-z0-9_-]+)\/?$/)?.[1];
const hostRoom = path.match(/^\/host\/([A-Za-z0-9_-]+)\/?$/)?.[1];

document.documentElement.dataset.surface = hostRoom ? 'panel' : 'paper';
if (path === '/styleguide') document.documentElement.dataset.page = 'styleguide';

function Route() {
  if (guestRoom) return <GuestApp room={guestRoom} />;
  if (hostRoom) return <HostApp room={hostRoom} />;
  if (path === '/admin' || path.startsWith('/admin/')) return <AdminApp />;
  if (path === '/styleguide') return <StyleGuide />;
  return <Home />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Route />
    </Suspense>
  </StrictMode>,
);
