import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthGate } from './AuthGate';
import { Layout } from './Layout';
import { PRODUCT_DESCRIPTION, PRODUCT_NAME } from '../lib/product';
import { readFileSync } from 'node:fs';

describe('product identity', () => {
  it('names the product once and omits the default venue label', () => {
    const markup = renderToStaticMarkup(<Layout>Courts</Layout>);
    expect(markup).toContain(`<h1>${PRODUCT_NAME}</h1>`);
    expect(markup.match(new RegExp(PRODUCT_NAME, 'g'))).toHaveLength(1);
    expect(markup).not.toContain('Court Operations');
    expect(markup).toContain('Sydney');
    expect(markup).toContain(`src="/app-logo.png" alt="Hermit Edge"`);
    expect(markup).toContain(`<h1>${PRODUCT_NAME}</h1><p class="app-brand__description">${PRODUCT_DESCRIPTION}</p>`);
    expect(markup).not.toContain('app-brand__mark');
  });

  it('keeps a configured venue alongside the product', () => {
    const venueName = 'Riverside Pickleball Club';
    const markup = renderToStaticMarkup(<Layout venueName={venueName}>Courts</Layout>);
    expect(markup).toContain(`<h1>${PRODUCT_NAME}</h1>`);
    expect(markup).toContain(`class="app-brand__venue" title="${venueName}">${venueName}</span>`);
  });

  it('places one quiet copyright footer after the working content', () => {
    const markup = renderToStaticMarkup(<Layout>Courts</Layout>);
    expect(markup).toContain('</main><footer class="app-footer"><small>© Emman Ermitaño. All rights reserved.</small></footer>');
    expect(markup.match(/All rights reserved\./g)).toHaveLength(1);
  });

  it.each([PRODUCT_NAME, 'court steward', ' Court Operations ', ''])('omits a duplicate or empty venue label: %s', (venueName) => {
    const markup = renderToStaticMarkup(<Layout venueName={venueName}>Courts</Layout>);
    expect(markup).not.toContain('class="app-brand__venue"');
  });

  it('uses the same product name on the operator gate', () => {
    const markup = renderToStaticMarkup(<AuthGate error={null} isLoading={false} onSubmit={async () => true} onClearError={() => undefined} />);
    expect(markup).toContain(`>${PRODUCT_NAME}</h1>`);
    expect(markup).toContain('Operator code');
    expect(markup).not.toContain('Court Operations');
    expect(markup).toContain('src="/app-logo.png" alt="Hermit Edge"');
    expect(markup).toContain(PRODUCT_DESCRIPTION);
  });

  it('keeps the browser title limited to the product name and the existing logo favicon', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<title>Sidecourt</title>');
    expect(html).toContain('type="image/png" href="/app-logo.png"');
  });

  it('keeps narrow workspace navigation below the brand and intake actions', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    expect(css).toContain('.app-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto 44px;');
    expect(css).toContain('.workspace-tabs { grid-column: 1 / -1; grid-row: 2;');
    expect(css).toContain('.app-header__tools { grid-column: 2; grid-row: 1;');
  });

  it('puts Reports alongside Courts and Roster with one selected workspace', () => {
    const html = renderToStaticMarkup(<Layout activeView="reports" onViewChange={() => undefined}>Report</Layout>);
    expect(html).toContain('aria-pressed="false">Courts');
    expect(html).toContain('aria-pressed="false">Roster');
    expect(html).toContain('aria-pressed="true">Reports');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
