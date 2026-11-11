import { describe, expect, it, vi } from 'vitest';
import { animateCourtCommit } from './courtMotion';

const assigned = { status: 'available', ids: 'one,two,three,four' };
const playing = { ...assigned, status: 'in-play' };
const empty = { status: 'available', ids: '' };
const animated = () => {
  const animation = { cancel: vi.fn() };
  return { animation, animate: vi.fn<(keyframes: Keyframe[], options: KeyframeAnimationOptions) => typeof animation>(() => animation) };
};
const fixture = () => {
  const article = animated();
  const roster = animated();
  const players = animated();
  const timer = animated();
  const querySelector = vi.fn((selector: string) => selector === '.court-card__roster' ? roster
    : selector === '.court-card__players' ? players
      : selector === '.court-timer' ? timer : null);
  const element = { animate: article.animate, querySelector } as unknown as HTMLElement;
  return { element, article, roster, players, timer, querySelector };
};

describe('committed court surface acknowledgement', () => {
  it('cancels an active gesture immediately when reduced motion is enabled and does not replay on disable', () => {
    const value = fixture();
    const preference = Object.assign(new EventTarget(), { matches: false });
    const remove = vi.spyOn(preference, 'removeEventListener');
    const cleanup = animateCourtCommit(value.element, empty, playing, preference as unknown as MediaQueryList);
    preference.matches = true;
    preference.dispatchEvent(new Event('change'));
    for (const target of [value.article, value.roster]) expect(target.animation.cancel).toHaveBeenCalledOnce();
    preference.matches = false;
    preference.dispatchEvent(new Event('change'));
    for (const target of [value.article, value.roster]) expect(target.animate).toHaveBeenCalledOnce();
    cleanup();
    cleanup();
    expect(remove).toHaveBeenCalledOnce();
    for (const target of [value.article, value.roster]) expect(target.animation.cancel).toHaveBeenCalledOnce();
  });

  it('does not start or subscribe to a gesture when the live preference already requests reduced motion', () => {
    const value = fixture();
    const preference = Object.assign(new EventTarget(), { matches: true });
    const add = vi.spyOn(preference, 'addEventListener');
    animateCourtCommit(value.element, empty, playing, preference as unknown as MediaQueryList)();
    expect(add).not.toHaveBeenCalled();
    for (const target of [value.article, value.roster, value.players, value.timer]) expect(target.animate).not.toHaveBeenCalled();
  });

  it('removes the live preference subscription when a court effect is replaced', () => {
    const value = fixture();
    const preference = Object.assign(new EventTarget(), { matches: false });
    const remove = vi.spyOn(preference, 'removeEventListener');
    const cleanup = animateCourtCommit(value.element, empty, playing, preference as unknown as MediaQueryList);
    cleanup();
    preference.matches = true;
    preference.dispatchEvent(new Event('change'));
    expect(remove).toHaveBeenCalledOnce();
    for (const target of [value.article, value.roster]) expect(target.animation.cancel).toHaveBeenCalledOnce();
  });

  it('does not animate unchanged state, including repeated timer renders', () => {
    const value = fixture();
    for (let tick = 0; tick < 5; tick += 1) {
      animateCourtCommit(value.element, playing, { ...playing }, false)();
    }
    expect(value.querySelector).not.toHaveBeenCalled();
    for (const target of [value.article, value.roster, value.players, value.timer]) {
      expect(target.animate).not.toHaveBeenCalled();
      expect(target.animation.cancel).not.toHaveBeenCalled();
    }
  });

  it.each([
    [assigned, playing], [empty, assigned], [playing, empty],
  ])('respects reduced motion for committed changes from %j to %j', (previous, current) => {
    const value = fixture();
    expect(() => animateCourtCommit(value.element, previous, current, true)()).not.toThrow();
    expect(value.querySelector).not.toHaveBeenCalled();
    for (const target of [value.article, value.roster, value.players, value.timer]) expect(target.animate).not.toHaveBeenCalled();
  });

  it('acknowledges the real roster surface without claiming timer or player transforms', () => {
    const value = fixture();
    const cleanup = animateCourtCommit(value.element, assigned, playing, false);
    expect(value.roster.animate).toHaveBeenCalledWith([
      { backgroundColor: '#346a51', opacity: 0.88 }, { backgroundColor: '#245c46', opacity: 1 },
    ], { duration: 380, easing: 'ease-out', iterations: 1 });
    expect(value.timer.animate).not.toHaveBeenCalled();
    expect(value.players.animate).not.toHaveBeenCalled();
    expect(value.article.animate).not.toHaveBeenCalled();
    animateCourtCommit(value.element, playing, { ...playing }, false)();
    expect(value.querySelector).toHaveBeenCalledExactlyOnceWith('.court-card__roster');
    cleanup();
    expect(value.roster.animation.cancel).toHaveBeenCalledOnce();
    expect(value.timer.animation.cancel).not.toHaveBeenCalled();
  });

  it('never applies transform keyframes alongside Motion layout ownership', () => {
    const value = fixture();
    animateCourtCommit(value.element, empty, playing, false);
    for (const target of [value.article, value.roster]) {
      const frames = target.animate.mock.calls.flatMap(([keyframes]) => keyframes);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame).not.toHaveProperty('transform');
    }
    for (const target of [value.players, value.timer]) expect(target.animate).not.toHaveBeenCalled();
  });

  it('acknowledges assignment with an outline without touching draggable rows', () => {
    const value = fixture();
    animateCourtCommit(value.element, empty, assigned, false);
    expect(value.players.animate).not.toHaveBeenCalled();
    expect(value.roster.animate).not.toHaveBeenCalled();
    expect(value.timer.animate).not.toHaveBeenCalled();
    expect(value.querySelector).not.toHaveBeenCalled();
    expect(value.article.animate).toHaveBeenCalledWith([
      { outlineColor: '#245c46' }, { outlineColor: 'transparent' },
    ], { duration: 520, easing: 'ease-out', iterations: 1 });
  });

  it('acknowledges a completed match without translating an empty roster', () => {
    const value = fixture();
    const cleanup = animateCourtCommit(value.element, playing, empty, false);
    expect(value.article.animate).toHaveBeenCalledOnce();
    expect(value.article.animate.mock.calls[0]?.[1]).toEqual({ duration: 520, easing: 'ease-out', iterations: 1 });
    expect(value.querySelector).not.toHaveBeenCalled();
    expect(value.timer.animate).not.toHaveBeenCalled();
    cleanup();
    expect(value.article.animation.cancel).toHaveBeenCalledOnce();
  });

  it('detects changed team ordering rather than only changed player count', () => {
    const value = fixture();
    animateCourtCommit(value.element, assigned, { ...assigned, ids: 'one,three,two,four' }, false);
    expect(value.players.animate).not.toHaveBeenCalled();
    expect(value.article.animate).toHaveBeenCalledOnce();
  });

  it('does not replay the timer entrance for a participant change during play', () => {
    const value = fixture();
    animateCourtCommit(value.element, playing, { ...playing, ids: 'one,three,two,four' }, false);
    expect(value.players.animate).not.toHaveBeenCalled();
    expect(value.article.animate).toHaveBeenCalledOnce();
    expect(value.timer.animate).not.toHaveBeenCalled();
    expect(value.roster.animate).not.toHaveBeenCalled();
  });

  it('acknowledges closing and reopening a court without fabricating players', () => {
    const value = fixture();
    const closed = { ...empty, status: 'disabled' };
    animateCourtCommit(value.element, empty, closed, false);
    animateCourtCommit(value.element, closed, empty, false);
    expect(value.article.animate).toHaveBeenCalledTimes(2);
    expect(value.querySelector).not.toHaveBeenCalled();
  });

  it('cancels every owned animation when the effect is replaced or unmounted', () => {
    const value = fixture();
    const cleanup = animateCourtCommit(value.element, empty, playing, false);
    for (const target of [value.article, value.roster]) expect(target.animation.cancel).not.toHaveBeenCalled();
    cleanup();
    for (const target of [value.article, value.roster]) expect(target.animation.cancel).toHaveBeenCalledOnce();
  });

  it('handles missing roster and team surfaces while retaining article feedback', () => {
    const article = animated();
    const element = { animate: article.animate, querySelector: () => null } as unknown as HTMLElement;
    const cleanup = animateCourtCommit(element, empty, playing, false);
    expect(article.animate).toHaveBeenCalledOnce();
    expect(() => cleanup()).not.toThrow();
    expect(article.animation.cancel).toHaveBeenCalledOnce();
  });

  it('works when Web Animations is unavailable and keeps cleanup safe', () => {
    const element = { querySelector: () => ({}) } as unknown as HTMLElement;
    expect(() => animateCourtCommit(element, empty, playing, false)()).not.toThrow();
  });
});
