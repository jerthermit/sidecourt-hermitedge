import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DragMotionContext,
  interactionTransition,
  reducedMotionSnapshot,
  subscribeReducedMotion,
  useMotionPolicy,
} from './interactionMotion';
import { InteractionMotionRoot } from '../components/InteractionMotionRoot';

afterEach(() => vi.unstubAllGlobals());

function PolicyProbe() {
  const policy = useMotionPolicy();
  return <output data-reduced={policy.reduced} data-dragging={policy.dragging}
    data-layout={policy.layout} data-duration={policy.transition.duration} />;
}

describe('live interaction motion preference', () => {
  it('supports server rendering without browser globals or subscriptions', () => {
    vi.stubGlobal('window', undefined);
    expect(reducedMotionSnapshot()).toBe(false);
    expect(() => subscribeReducedMotion(vi.fn())()).not.toThrow();
    const html = renderToStaticMarkup(<InteractionMotionRoot><PolicyProbe /></InteractionMotionRoot>);
    expect(html).toContain('data-reduced="false"');
    expect(html).toContain('data-layout="true"');
  });

  it('works in browsers without a matchMedia implementation', () => {
    vi.stubGlobal('window', {});
    expect(reducedMotionSnapshot()).toBe(false);
    expect(() => subscribeReducedMotion(vi.fn())()).not.toThrow();
  });

  it('notifies on a live preference change, reads the current value and unsubscribes cleanly', () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    const matchMedia = vi.fn(() => media);
    vi.stubGlobal('window', { matchMedia });
    const snapshots: boolean[] = [];
    const notify = vi.fn(() => snapshots.push(reducedMotionSnapshot()));
    const remove = vi.spyOn(media, 'removeEventListener');
    const unsubscribe = subscribeReducedMotion(notify);
    expect(reducedMotionSnapshot()).toBe(false);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');

    media.matches = true;
    media.dispatchEvent(new Event('change'));
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    expect(snapshots).toEqual([true, false]);

    unsubscribe();
    expect(remove).toHaveBeenCalledExactlyOnceWith('change', notify);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('keeps server and hydration markup stable even when the browser preference is reduced', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(reducedMotionSnapshot()).toBe(true);
    const html = renderToStaticMarkup(<InteractionMotionRoot><PolicyProbe /></InteractionMotionRoot>);
    expect(html).toContain('data-reduced="false"');
    expect(html).toContain('data-layout="true"');
  });

  it.each([false, true])('suspends layout and transition duration during dragging=%s', (dragging) => {
    vi.stubGlobal('window', undefined);
    const html = renderToStaticMarkup(<DragMotionContext.Provider value={dragging}>
      <PolicyProbe />
    </DragMotionContext.Provider>);
    expect(html).toContain(`data-dragging="${dragging}"`);
    expect(html).toContain(`data-layout="${!dragging}"`);
    expect(html).toContain(`data-duration="${dragging ? 0 : interactionTransition.duration}"`);
  });
});
