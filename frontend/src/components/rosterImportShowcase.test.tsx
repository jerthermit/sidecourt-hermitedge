import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RosterImportModal } from './RosterImportModal';

const base = {
  returnFocusTo: null, result: null, isSaving: false, error: null,
  onPreview: async () => true, onImport: async () => true,
  onClear: () => undefined, onClose: () => undefined,
};

describe('roster import showcase', () => {
  it('previews genuine unknown ratings without replacing them with an estimate', () => {
    const markup = renderToStaticMarkup(<RosterImportModal {...base} preview={{
      source: 'Members', newCount: 1, existingCount: 0, conflictCount: 0,
      rows: [{ externalId: 'member-41', name: 'Alex Morgan', skillLevel: 'unrated', skillRating: null, playStyle: 'Balanced', status: 'new', message: null }],
    }} />);
    expect(markup).toContain('unrated');
    expect(markup).toContain('aria-label="Local rating not recorded">—');
    expect(markup).toContain('member-41');
    expect(markup).toContain('New profile');
    expect(markup).toContain('Import 1 player');
    expect(markup).not.toContain('0.0');
  });

  it('explains the prepared-file boundary, stable identity and batch limit', () => {
    const markup = renderToStaticMarkup(<RosterImportModal {...base} preview={null} mapping={{ externalId: 'Member', name: 'Participant' }} onSaveMapping={async () => true} />);
    expect(markup).toContain('Player ID and name required. Up to 200 players.');
    expect(markup).toContain('Reuse the same source label and player IDs to match existing profiles.');
    expect(markup).toContain('Use a club or booking-platform CSV.');
    expect(markup).toContain('Bookings and official ratings stay at their source.');
    expect(markup).not.toContain('Required: external_id, name, level, rating');
    expect(markup).toContain('<dialog');
    expect(markup).toContain('Preview roster');
  });

  it('shows the exact profile differences and requires an unchecked approval before applying', () => {
    const markup = renderToStaticMarkup(<RosterImportModal {...base} preview={{
      source: 'club roster', revision: 17, newCount: 0, existingCount: 0, conflictCount: 1,
      rows: [{ externalId: 'member-041', name: 'Alexandra Morgan', skillLevel: 'intermediate', skillRating: 3.4,
        playStyle: 'Balanced', status: 'conflict', message: 'Review profile correction.', canUpdate: true,
        current: { name: 'Alex Morgan', skillLevel: 'intermediate', skillRating: 3.1, playStyle: 'Balanced' } }],
    }} />);
    expect(markup).toContain('Name: Alex Morgan → Alexandra Morgan');
    expect(markup).toContain('Local rating: 3.1 → 3.4');
    expect(markup).toContain('Update changed profiles');
    expect(markup).not.toContain('checked=""');
    expect(markup).toMatch(/disabled=""[^>]*>Apply roster/);
    expect(markup).not.toContain('Resolve conflicts');
  });

  it('keeps an active or ambiguous identity blocked instead of offering an update override', () => {
    const markup = renderToStaticMarkup(<RosterImportModal {...base} preview={{
      source: 'club roster', revision: 17, newCount: 0, existingCount: 0, conflictCount: 1,
      rows: [{ externalId: 'member-041', name: 'Alex Morgan', skillLevel: 'intermediate', skillRating: 3.4,
        playStyle: 'Balanced', status: 'conflict', message: 'Player has a game in progress.', canUpdate: false }],
    }} />);
    expect(markup).toContain('Player has a game in progress.');
    expect(markup).toContain('Resolve conflicts before importing.');
    expect(markup).not.toContain('Update changed profiles');
    expect(markup).toMatch(/disabled=""[^>]*>Import roster/);
  });

  it('offers enrollment for existing club identities without treating them as already in this session', () => {
    const markup = renderToStaticMarkup(<RosterImportModal {...base} preview={{
      source: 'club roster', revision: 17, newCount: 0, existingCount: 1, conflictCount: 0, enrollCount: 1,
      rows: [{ externalId: 'member-041', name: 'Alex Morgan', skillLevel: 'unrated', skillRating: null,
        playStyle: 'Balanced', status: 'existing', message: null }],
    }} />);
    expect(markup).toContain('1 joining');
    expect(markup).toContain('1 matching profile');
    expect(markup).toContain('Profile matches');
    expect(markup).toContain('Import 1 player');
    expect(markup).not.toContain('>Done</button>');
    const completed = renderToStaticMarkup(<RosterImportModal {...base} preview={null} result={{ added: 0, enrolled: 1, skipped: 0, updated: 0 }} />);
    expect(completed).toContain('<strong>1</strong><h3>player added</h3>');
    expect(completed).toContain('Awaiting check-in.');
  });
});
