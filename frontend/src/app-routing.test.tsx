import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { PlayerDisplay } from './components/PlayerDisplay';

const hooks = vi.hoisted(() => ({ externalStore: vi.fn() }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: hooks.externalStore,
}));

describe('player-screen location routing', () => {
  let events: EventTarget;
  let location: { hash: string };
  beforeEach(() => {
    events = new EventTarget();
    location = { hash: '#display=first-screen' };
    vi.stubGlobal('window', {
      location,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    });
    hooks.externalStore.mockReset();
    hooks.externalStore.mockImplementation((_subscribe, read) => read());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('subscribes to same-document link changes and changes the display identity', () => {
    const first = App();
    expect(first.type).toBe(PlayerDisplay);
    expect(first.props.accessKey).toBe('first-screen');
    const [subscribe, read] = hooks.externalStore.mock.calls[0];
    const changed = vi.fn();
    const unsubscribe = subscribe(changed);

    location.hash = '#display=second-screen';
    events.dispatchEvent(new Event('hashchange'));
    expect(changed).toHaveBeenCalledOnce();
    expect(read()).toBe('#display=second-screen');
    const second = App();
    expect(second.props.accessKey).toBe('second-screen');
    expect(second.key).not.toBe(first.key);
    expect(hooks.externalStore.mock.calls[1][0]).toBe(subscribe);

    unsubscribe();
    events.dispatchEvent(new Event('hashchange'));
    expect(changed).toHaveBeenCalledOnce();
  });

  it('leaves display routing when its fragment is removed and does not expose credentials in markup', () => {
    const first = App();
    location.hash = '';
    const host = App();
    expect(host.type).not.toBe(PlayerDisplay);
    expect(host.key).toBeNull();
    expect(host.props).not.toHaveProperty('accessKey');
    expect(first.props.accessKey).toBe('first-screen');
    expect(hooks.externalStore.mock.calls[0][2]()).toBe('');
  });
});
