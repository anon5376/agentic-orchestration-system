import { useCallback, useEffect, useState } from 'react';
import { defaultRoute, normalizeRoutePath, routeForPath } from '../data/demoState';

function readHash() {
  if (typeof window === 'undefined') return defaultRoute;
  return normalizeRoutePath(window.location.hash || defaultRoute);
}

export function useHashRouter() {
  const [path, setPath] = useState(readHash);

  useEffect(() => {
    const sync = () => setPath(readHash());
    window.addEventListener('hashchange', sync);
    if (!window.location.hash) window.location.hash = defaultRoute;
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const navigate = useCallback((nextPath) => {
    const normalized = normalizeRoutePath(nextPath);
    if (typeof window === 'undefined') return;
    if (window.location.hash === `#${normalized}`) {
      setPath(normalized);
      return;
    }
    window.location.hash = normalized;
  }, []);

  return { path, route: routeForPath(path), navigate };
}
