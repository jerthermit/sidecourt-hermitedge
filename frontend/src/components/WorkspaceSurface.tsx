import type { ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { useMotionPolicy } from '../lib/interactionMotion';

export function WorkspaceSurface({ className, children }: { className: string; children: ReactNode }) {
  const present = useIsPresent();
  const policy = useMotionPolicy();
  return <motion.div className={className} inert={!present}
    initial={policy.layout ? { opacity: 0, y: 8 } : false}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: policy.layout ? -5 : 0, transition: { duration: policy.layout ? 0.1 : 0 } }}
    transition={policy.transition}>
    {children}
  </motion.div>;
}
