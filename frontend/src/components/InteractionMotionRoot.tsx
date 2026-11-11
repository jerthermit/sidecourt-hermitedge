import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { interactionTransition, useMotionPolicy } from '../lib/interactionMotion';

export function InteractionMotionRoot({ children }: { children: ReactNode }) {
  const { reduced } = useMotionPolicy();
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'} transition={interactionTransition}>{children}</MotionConfig>;
}
