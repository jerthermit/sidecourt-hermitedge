import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CourtDiagram } from './CourtDiagram';

describe('proportioned court illustration', () => {
  const html = renderToStaticMarkup(<CourtDiagram />);

  it('uses the same ground scale for the 44-foot length and 20-foot width', () => {
    expect(html).toContain('class="court-diagram__surface" points="12,29 82.4,59.8 114.4,45.8 44,15"');
    const length = Math.hypot(82.4 - 12, 59.8 - 29);
    const width = Math.hypot(44 - 12, 15 - 29);
    expect(length / width).toBeCloseTo(44 / 20);
  });

  it('spans the width at midcourt with short upright posts, not a diagonal across the court', () => {
    expect(html).toContain('class="court-diagram__net"');
    expect(html).toContain('class="court-diagram__tape" d="M45.6,39.1Q63.2,32.067 80.8,23.7"');
    expect(html).toContain('M45.6,45.1L45.6,38.8M80.8,29.7L80.8,23.4');
    // The quadratic control is 4in below the edges; its midpoint sags 2in.
    const sideHeight = 3;
    const controlHeight = sideHeight - 1 / 3;
    expect((sideHeight + controlHeight) / 2).toBeCloseTo(34 / 12);
  });

  it('keeps each kitchen boundary seven feet from the net and service lines outside it', () => {
    expect(html).toContain('class="court-diagram__kitchen" points="36,39.5 58.4,49.3 90.4,35.3 68,25.5"');
    expect(html).toContain('M36,39.5L68,25.5M58.4,49.3L90.4,35.3');
    expect(html).toContain('M28,22L52,32.5M74.4,42.3L98.4,52.8');
    expect(22 - 15).toBe(7);
    expect(29 - 22).toBe(7);
  });

  it('adds a shallow solid edge and legible net weave without filters or raster assets', () => {
    expect(html).toContain('class="court-diagram__slab"');
    expect(html).toContain('points="12,29 82.4,59.8 82.4,61.4 12,30.6"');
    expect(html).toContain('points="82.4,59.8 114.4,45.8 114.4,47.4 82.4,61.4"');
    const weave = html.match(/class="court-diagram__weave"[^>]*>(.*?)<\/g>/)?.[1] ?? '';
    expect(weave.match(/<path\b/g)).toHaveLength(14);
    expect(html).not.toMatch(/<filter\b|<image\b|<pattern\b|<[^>]*Gradient\b|<animate\b/);
    expect(html.match(/#[a-f0-9]{6}/gi)?.every((color) => ['#192f26', '#245c46', '#edf3ed'].includes(color))).toBe(true);
  });

  it('remains decorative and within a compact shared viewport', () => {
    expect(html).toContain('viewBox="0 0 128 72" aria-hidden="true" focusable="false"');
    expect(html).not.toMatch(/<text\b|<image\b|tabindex=|<title\b/);
  });
});
