import { useState, useSyncExternalStore } from 'react';

const compactQuery = '(max-width: 600px)';
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(compactQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const compactSnapshot = () => window.matchMedia(compactQuery).matches;
const railQuery = '(max-width: 600px), (min-width: 1440px)';
const subscribeRail = (notify: () => void) => {
  const media = window.matchMedia(railQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const railSnapshot = () => window.matchMedia(railQuery).matches;
const serverSnapshot = () => false;

export function usePageSize(narrowRail = false) {
  const compact = useSyncExternalStore(narrowRail ? subscribeRail : subscribe, narrowRail ? railSnapshot : compactSnapshot, serverSnapshot);
  const [selected, setSelected] = useState<number | null>(null);
  return [selected ?? (compact ? 6 : 12), setSelected] as const;
}
