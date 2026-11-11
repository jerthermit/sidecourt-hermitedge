import type { Active, Over } from '@dnd-kit/core';
import { describe, expect, it } from 'vitest';
import { dragAnnouncements } from './dragAccessibility';

const active: Active = { id: 'opaque-player-id', data: { current: { player: { name: 'Alex Wilkins' } } }, rect: { current: { initial: null, translated: null } } };
const target = (data: Record<string, unknown>): Over => ({ id: 'opaque-target-id', data: { current: data }, disabled: false,
  rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } });
const announcements = dragAnnouncements([{ id: 2, name: 'South' }]);

describe('named keyboard drag feedback', () => {
  it('uses player names for pickup and cancellation, never opaque identifiers', () => {
    expect(announcements.onDragStart({ active })).toBe('Alex Wilkins picked up.');
    expect(announcements.onDragCancel({ active, over: null })).toBe('Alex Wilkins move cancelled.');
    const over = { ...target({ type: 'player', player: { name: 'Alex Wilkins' } }), id: active.id };
    expect(announcements.onDragOver({ active, over })).toBeUndefined();
    expect(announcements.onDragEnd({ active, over })).toBe('Alex Wilkins released in place.');
  });
  it.each([
    [{ type: 'holding-pool' }, 'Waiting'],
    [{ type: 'court', courtId: 2 }, 'South'],
    [{ type: 'next-game-pool', lane: 'mixed' }, 'Open group staging'],
    [{ type: 'player', player: { name: 'Zara Kapoor' } }, "Zara Kapoor's position"],
    [{ type: 'next-game-pool' }, 'Next game staging'],
    [{ type: 'court', courtId: 99 }, 'the court'],
  ])('describes the actual target without announcing a server-committed move', (data, label) => {
    expect(announcements.onDragOver({ active, over: target(data) })).toBe(`Alex Wilkins over ${label}.`);
    expect(announcements.onDragEnd({ active, over: target(data) })).toBe(`Alex Wilkins dropped over ${label}.`);
  });
  it('does not invent a destination when outside a drop area', () => {
    expect(announcements.onDragEnd({ active, over: null })).toBe('Alex Wilkins released outside a drop area.');
  });
});
