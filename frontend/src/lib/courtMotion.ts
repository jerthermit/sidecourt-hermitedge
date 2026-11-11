interface CourtMotionState {
  status: string;
  ids: string;
}

export function animateCourtCommit(
  element: HTMLElement,
  previous: CourtMotionState,
  current: CourtMotionState,
  reducedMotion: boolean | MediaQueryList,
): () => void {
  const animations: Animation[] = [];
  const preference = typeof reducedMotion === 'boolean' ? null : reducedMotion;
  let subscribed = false;
  const cancelAnimations = () => animations.splice(0).forEach((animation) => animation.cancel());
  const preferenceChanged = () => { if (preference?.matches) cancelAnimations(); };
  const cleanup = () => {
    if (subscribed) { preference?.removeEventListener('change', preferenceChanged); subscribed = false; }
    cancelAnimations();
  };
  const playersChanged = previous.ids !== current.ids;
  if ((typeof reducedMotion === 'boolean' ? reducedMotion : reducedMotion.matches)
    || (!playersChanged && previous.status === current.status)) return cleanup;

  const animate = (target: Element | null, keyframes: Keyframe[], duration: number) => {
    const animation = target?.animate?.(keyframes, { duration, easing: 'ease-out', iterations: 1 });
    if (animation) animations.push(animation);
  };

  if (previous.status !== 'in-play' && current.status === 'in-play') {
    animate(element.querySelector('.court-card__roster'), [
      { backgroundColor: '#346a51', opacity: 0.88 },
      { backgroundColor: '#245c46', opacity: 1 },
    ], 380);
  }
  if (playersChanged || current.status !== 'in-play') {
    animate(element, [{ outlineColor: '#245c46' }, { outlineColor: 'transparent' }], 520);
  }

  if (preference && animations.length > 0) {
    preference.addEventListener('change', preferenceChanged);
    subscribed = true;
  }
  return cleanup;
}
