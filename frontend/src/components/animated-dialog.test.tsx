import { createRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnimatedDialog } from './AnimatedDialog';

const state = vi.hoisted(() => ({
  present: true, reduced: false, props: null as Record<string, unknown> | null,
}));

vi.mock('motion/react', async () => {
  const { createElement } = await import('react');
  return {
    useIsPresent: () => state.present,
    motion: { dialog: (props: Record<string, unknown>) => {
      state.props = props;
      return createElement('dialog', {
        ref: props.ref, className: props.className, inert: props.inert,
        'aria-labelledby': props['aria-labelledby'],
        'data-motion-present': props['data-motion-present'],
      }, props.children as ReactNode);
    } },
  };
});

vi.mock('../lib/interactionMotion', () => ({
  interactionEase: [0.22, 0.75, 0.2, 1],
  useMotionPolicy: () => ({ reduced: state.reduced }),
}));

beforeEach(() => { state.present = true; state.reduced = false; state.props = null; });

describe('native animated dialog', () => {
  it('forwards its native ref and accessible label without opening or closing it on render', () => {
    const ref = createRef<HTMLDialogElement>();
    const onCancel = vi.fn();
    const html = renderToStaticMarkup(<AnimatedDialog ref={ref} className="dialog" aria-labelledby="review-title" onCancel={onCancel}>
      <h2 id="review-title">Review</h2><button type="submit">Confirm</button>
    </AnimatedDialog>);
    expect(html).toContain('<dialog class="dialog" aria-labelledby="review-title"');
    expect(html).toContain('<button type="submit">Confirm</button>');
    expect(html).not.toContain('inert=');
    expect(state.props?.ref).toBe(ref);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('uses short tween entrance and exit with no spring', () => {
    renderToStaticMarkup(<AnimatedDialog />);
    expect(state.props?.initial).toEqual({ opacity: 0, y: 8, scale: 0.985 });
    expect(state.props?.animate).toEqual({ opacity: 1, y: 0, scale: 1 });
    expect(state.props?.transition).toMatchObject({ type: 'tween', duration: 0.22 });
    expect(state.props?.exit).toMatchObject({ opacity: 0, y: 5, scale: 0.992,
      transition: { type: 'tween', duration: 0.14 } });
  });

  it('removes movement and delay under reduced motion', () => {
    state.reduced = true;
    renderToStaticMarkup(<AnimatedDialog />);
    expect(state.props?.initial).toBe(false);
    expect(state.props?.transition).toMatchObject({ duration: 0 });
    expect(state.props?.exit).toMatchObject({ y: 0, scale: 1, transition: { duration: 0 } });
  });

  it('immediately makes exiting content inert and blocks repeated stale interactions', () => {
    state.present = false;
    const callbacks = { onClickCapture: vi.fn(), onSubmitCapture: vi.fn(), onKeyDownCapture: vi.fn(), onCancel: vi.fn() };
    const html = renderToStaticMarkup(<AnimatedDialog {...callbacks}><button>Remove player</button></AnimatedDialog>);
    expect(html).toContain('inert=""');
    expect(state.props?.['data-motion-present']).toBe(false);
    for (const name of Object.keys(callbacks) as Array<keyof typeof callbacks>) {
      const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
      const handler = state.props?.[name] as (interaction: typeof event) => void;
      handler(event);
      handler(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(2);
      expect(event.stopPropagation).toHaveBeenCalledTimes(2);
      expect(callbacks[name]).not.toHaveBeenCalled();
    }
  });

  it('preserves native interaction handlers while present', () => {
    const onCancel = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    renderToStaticMarkup(<AnimatedDialog onCancel={onCancel} />);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (state.props?.onCancel as (interaction: typeof event) => void)(event);
    expect(onCancel).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
