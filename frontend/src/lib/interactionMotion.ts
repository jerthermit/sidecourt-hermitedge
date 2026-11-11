import { createContext, useContext, useSyncExternalStore } from 'react';

export const DragMotionContext = createContext(false);
export const interactionEase = [0.22, 0.75, 0.2, 1] as const;
export const interactionTransition = { type: 'tween', duration: 0.26, ease: interactionEase } as const;

const motionQuery = '(prefers-reduced-motion: reduce)';
export const reducedMotionSnapshot = () => typeof window !== 'undefined'
  && typeof window.matchMedia === 'function' && window.matchMedia(motionQuery).matches;
export const subscribeReducedMotion = (notify: () => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(motionQuery);
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
};
const serverSnapshot = () => false;
const useReducedPreference = () => useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, serverSnapshot);

export function useMotionPolicy() {
  const dragging = useContext(DragMotionContext);
  const reduced = useReducedPreference();
  return {
    reduced,
    dragging,
    layout: !dragging && !reduced,
    transition: reduced || dragging ? { duration: 0 } : interactionTransition,
  };
}
