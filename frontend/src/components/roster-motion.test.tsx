import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Player } from '../types/models';
import { Roster } from './Roster';
import { RosterRows } from './RosterRows';

const state = vi.hoisted(() => ({
  present: true, reduced: false, dragging: false,
  body: null as Record<string, unknown> | null,
  rows: [] as Array<Record<string, unknown>>,
  menus: [] as Array<Record<string, unknown>>,
  pages: [] as Array<{ key: string | null; mode: unknown; initial: unknown }>,
}));

vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  const { createElement, isValidElement } = await import('react');
  const motionProps = new Set(['initial', 'animate', 'exit', 'transition', 'layout', 'onAnimationComplete']);
  const element = (tag: string) => (props: Record<string, unknown>) => {
    if (tag === 'tbody') state.body = props;
    if (tag === 'tr') state.rows.push(props);
    if (tag === 'div' && props.className === 'roster-more__menu') state.menus.push(props);
    return createElement(tag, Object.fromEntries(Object.entries(props).filter(([name]) => !motionProps.has(name))));
  };
  const elements = { tbody: element('tbody'), tr: element('tr'), div: element('div') };
  return { ...actual,
    useIsPresent: () => state.present,
    motion: new Proxy(actual.motion, { get: (target, name) => name in elements
      ? elements[name as keyof typeof elements] : Reflect.get(target, name) }),
    AnimatePresence: ({ children, mode, initial }: { children: import('react').ReactNode; mode?: string; initial?: boolean }) => {
      state.pages.push({ key: isValidElement(children) ? children.key : null, mode, initial });
      return children;
    },
  };
});

vi.mock('../lib/interactionMotion', () => ({
  interactionEase: [0.22, 0.75, 0.2, 1],
  useMotionPolicy: () => ({ reduced: state.reduced, dragging: state.dragging, layout: !state.reduced && !state.dragging }),
}));

const player: Player = {
  id: 'player-1', name: 'Alex Morgan', skillLevel: 'intermediate', skillRating: 3.4,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
  location: { type: 'holding-pool', index: 0 }, createdAt: 1, gamesPlayed: 2,
};
const renderRows = () => renderToStaticMarkup(<table><RosterRows players={[player]} courts={[]}
  playingCourts={new Map()} disabled={false} onAttendance={async () => true} onRequestRemove={() => undefined} /></table>);

beforeEach(() => {
  state.present = true; state.reduced = false; state.dragging = false;
  state.body = null; state.rows = []; state.menus = []; state.pages = [];
});

describe('bounded roster motion', () => {
  it('keeps a native table body and native disclosure, using opacity for pages and position for rows', () => {
    const html = renderRows();
    expect(html).toMatch(/^<table><tbody\b[^>]*><tr\b/);
    expect(html).toContain('<details class="roster-more"><summary');
    expect(html).toContain('aria-expanded="false"');
    expect(state.body?.initial).toEqual({ opacity: 0 });
    expect(state.body?.animate).toEqual({ opacity: 1 });
    expect(state.body?.exit).toMatchObject({ opacity: 0, transition: { duration: 0.12 } });
    expect(state.rows[0]?.layout).toBe('position');
    expect(state.menus[0]?.animate).toEqual({ height: 0, opacity: 0 });
    expect(state.menus[0]?.inert).toBe(true);
  });

  it('keys its bounded body by page, size, query and filter while preserving all roster counts', () => {
    const players = Array.from({ length: 31 }, (_, index) => ({ ...player, id: `player-${index}`, name: `Player ${index}` }));
    const html = renderToStaticMarkup(<Roster players={players} courts={[]} disabled={false}
      onImport={() => undefined} onAttendance={async () => true} />);
    expect(state.pages.find((page) => page.mode === 'wait')).toEqual({ key: '[1,12,"","all"]', mode: 'wait', initial: false });
    expect(state.rows).toHaveLength(12);
    expect(html).not.toContain('31 players');
    expect(html).toContain('All<span>31</span>');
    expect(html).toContain('Ready<span>31</span>');
  });

  it('makes an exiting page inert, disables row actions and blocks stale event capture', () => {
    state.present = false;
    const html = renderRows();
    expect(html).toContain('<tbody inert="" data-presence="exiting"');
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button).toContain('disabled=""');
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    for (const name of ['onClickCapture', 'onKeyDownCapture']) {
      (state.body?.[name] as (interaction: typeof event) => void)(event);
    }
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(event.stopPropagation).toHaveBeenCalledTimes(2);
  });

  it('guards closed disclosure actions even against programmatically dispatched events', () => {
    renderRows();
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    (state.menus[0]?.onClickCapture as (interaction: typeof event) => void)(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each(['reduced', 'dragging'] as const)('disables page, row and disclosure movement during %s', (policy) => {
    state[policy] = true;
    renderRows();
    expect(state.body?.initial).toBe(false);
    expect(state.body?.transition).toMatchObject({ duration: 0 });
    expect(state.body?.exit).toMatchObject({ transition: { duration: 0 } });
    expect(state.rows[0]?.layout).toBe(false);
    expect(state.rows[0]?.transition).toMatchObject({ duration: 0 });
    expect(state.menus[0]?.transition).toMatchObject({ duration: 0 });
  });
});
