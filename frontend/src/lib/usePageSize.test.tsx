import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { usePageSize } from './usePageSize';

const environment = vi.hoisted(() => ({ client: false }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => boolean, serverSnapshot: () => boolean) =>
    environment.client ? snapshot() : serverSnapshot(),
}));

function PageSize({ rail = false }: { rail?: boolean }) {
  const [size] = usePageSize(rail);
  return <output>{size}</output>;
}
afterEach(() => { environment.client = false; vi.unstubAllGlobals(); });

describe('responsive list page defaults', () => {
  it('renders a stable twelve-row server default without browser globals', () => {
    vi.stubGlobal('window', undefined);
    expect(renderToStaticMarkup(<PageSize rail />)).toBe('<output>12</output>');
  });
  it.each([
    { width: 390, rail: false, expected: 6 },
    { width: 390, rail: true, expected: 6 },
    { width: 1200, rail: true, expected: 12 },
    { width: 1440, rail: true, expected: 6 },
    { width: 1440, rail: false, expected: 12 },
  ])('uses $expected rows at $width pixels with narrow rail=$rail', ({ width, rail, expected }) => {
    environment.client = true;
    vi.stubGlobal('window', { matchMedia: (query: string) => ({
      matches: width <= 600 || (query.includes('min-width: 1440px') && width >= 1440),
    }) });
    expect(renderToStaticMarkup(<PageSize rail={rail} />)).toBe(`<output>${expected}</output>`);
  });
});
