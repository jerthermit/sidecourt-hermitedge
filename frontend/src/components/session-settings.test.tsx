import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClubSettings } from '../types/models';
import { SessionDialog } from './SessionDialog';

const settings: ClubSettings = { venueName: 'Harbour', courtCount: 16,
  courtNames: Array.from({ length: 16 }, (_, index) => `Harbour ${index + 1}`),
  timezone: 'Australia/Sydney', gameMode: 'doubles' };
const ok = async () => true;
const render = (hasActiveMatch = false) => renderToStaticMarkup(<SessionDialog
  settings={settings} session={{ id: 's', name: 'Social', startedAt: 1, endedAt: null }}
  busy={false} hasActiveMatch={hasActiveMatch} error={null} publicAccess={false}
  onClose={() => undefined} onSaveSettings={ok} onStart={ok} onEnd={ok}
  onReset={ok} />);

describe('club court settings', () => {
  it('offers one labeled control covering 1–16 courts and every configured name', () => {
    const html = render();
    const count = html.match(/<span>Number of courts<\/span><select[^>]*>(.*?)<\/select>/)?.[1];
    expect(count).toBeDefined();
    expect(count?.match(/<option /g)).toHaveLength(16);
    expect(count).toContain('<option value="1">1</option>');
    expect(count).toContain('<option value="16" selected="">16</option>');
    expect(count).not.toContain('value="17"');
    settings.courtNames?.forEach((name) => expect(html).toContain(`value="${name}"`));
    expect(html).toContain('>Save club</button>');
  });

  it('preserves the active-match lock and its visible reason', () => {
    const html = render(true);
    expect(html).toContain('<span>Number of courts</span><select disabled="">');
    expect(html).toMatch(/disabled="" value="Harbour 16"/);
    expect(html).toMatch(/disabled=""[^>]*>Import settings/);
    expect(html).toContain('End active matches to edit.');
  });

  it('offers deliberate roster reuse only when opening the next session, unchecked by default', () => {
    const html = renderToStaticMarkup(<SessionDialog settings={settings}
      session={{ id: 'closed', name: 'Previous social', startedAt: 1, endedAt: 2 }}
      busy={false} hasActiveMatch={false} error={null} publicAccess={false}
      onClose={() => undefined} onSaveSettings={ok} onStart={ok} onEnd={ok} onReset={ok} />);
    expect(html).toContain('Use previous roster');
    expect(html).not.toContain('type="checkbox" checked="" disabled');
    expect(html).toMatch(/<input type="checkbox"\/><span>Use previous roster<\/span>/);
    expect(html).toContain('maxLength="80"');
    expect(render()).not.toContain('Use previous roster');
  });
});
