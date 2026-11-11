import { forwardRef } from 'react';
import { motion, useIsPresent, type HTMLMotionProps } from 'motion/react';
import { interactionEase, useMotionPolicy } from '../lib/interactionMotion';

type AnimatedDialogProps = Omit<HTMLMotionProps<'dialog'>, 'initial' | 'animate' | 'exit' | 'transition'>;

/** Native modal lifetime and focus remain with the caller; presence owns only its visual exit. */
export const AnimatedDialog = forwardRef<HTMLDialogElement, AnimatedDialogProps>(function AnimatedDialog({
  children, inert, onClickCapture, onSubmitCapture, onKeyDownCapture, onCancel, ...props
}, ref) {
  const { reduced } = useMotionPolicy();
  const isPresent = useIsPresent();
  const guard = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    if (isPresent) return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  return <motion.dialog
    {...props}
    ref={ref}
    data-motion-dialog=""
    data-motion-present={isPresent}
    data-presence={isPresent ? 'present' : 'exiting'}
    inert={!isPresent || inert}
    initial={reduced ? false : { opacity: 0, y: 8, scale: 0.985 }}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    exit={{ opacity: 0, y: reduced ? 0 : 5, scale: reduced ? 1 : 0.992,
      transition: { type: 'tween', duration: reduced ? 0 : 0.14, ease: interactionEase } }}
    transition={{ type: 'tween', duration: reduced ? 0 : 0.22, ease: interactionEase }}
    onClickCapture={(event) => { if (!guard(event)) onClickCapture?.(event); }}
    onSubmitCapture={(event) => { if (!guard(event)) onSubmitCapture?.(event); }}
    onKeyDownCapture={(event) => { if (!guard(event)) onKeyDownCapture?.(event); }}
    onCancel={(event) => { if (!guard(event)) onCancel?.(event); }}
  >{children}</motion.dialog>;
});
