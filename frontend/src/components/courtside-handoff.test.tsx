import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Court } from './Court';
import { MatchProposalModal } from './MatchProposalModal';
import { PlayerScreenDialog } from './PlayerScreenDialog';
import type { Court as CourtModel, MatchProposal, Player } from '../types/models';

const ok = async () => true;
const player = (id: string): Player => ({ id, name: id, skillLevel: 'intermediate', skillRating: 3.5,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
  location: { type: 'holding-pool', index: 0 }, createdAt: 1 });
const players = ['Alex', 'Blair', 'Casey', 'Drew'].map(player);
const court = (id: number, overrides: Partial<CourtModel> = {}): CourtModel => ({
  id, name: id === 1 ? 'North' : 'South', status: 'available', players: [], gameStartedAt: null, timeElapsed: 0, ...overrides,
});
const proposal: MatchProposal = { id: 'review', players, targetLane: 'intermediate', source: 'rules-fallback',
  status: 'pending', summary: '', notice: 'Rules determined this pairing.', expiresAt: Date.now() + 60_000 };
const textOf = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const button = (html: string, label: string) => html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
  ?.find((value) => textOf(value).trim() === label);
const renderCourt = (value: CourtModel, canReviewNext = true, disabled = false, reviewMixed = false) => renderToStaticMarkup(
  <Court court={value} history={[]} onStartGame={ok} onEndGame={ok} onEndAndReview={ok}
    onReviewNext={ok} canReviewNext={canReviewNext} reviewMixed={reviewMixed} onToggleStatus={ok} onVoidGame={ok} disabled={disabled} />,
);
const renderReview = (courts: CourtModel[], preferredCourtId?: number) => renderToStaticMarkup(
  <MatchProposalModal proposal={proposal} courts={courts} preferredCourtId={preferredCourtId}
    error={null} isSaving={false} isProposalLoading={false} onApprove={ok} onDismiss={ok} onRequestAnother={ok} />,
);

describe('court-specific turnover controls', () => {
  it('offers the connected handoff, an end-only path and a distinct void action', () => {
    const html = renderCourt(court(2, { status: 'in-play', players, gameStartedAt: 1 }));
    for (const label of ['End & review', 'End only', 'Void']) expect(button(html, label)).toBeDefined();
    expect(button(html, 'Start')).toBeUndefined();
  });
  it('disables all completion actions while a committed operation is pending', () => {
    const html = renderCourt(court(2, { status: 'in-play', players, gameStartedAt: 1 }), true, true);
    for (const label of ['End & review', 'End only', 'Void']) expect(button(html, label)).toContain('disabled=""');
  });
  it('offers review on an empty court without a dead Start action', () => {
    const html = renderCourt(court(2));
    expect(button(html, 'Review group')).toBeDefined();
    expect(button(html, 'Review group')).not.toContain('disabled=""');
    expect(button(html, 'Start')).toBeUndefined();
  });
  it('does not enable review without an eligible or explicitly mixed group', () => {
    expect(button(renderCourt(court(2), false), 'Review group')).toContain('disabled=""');
    expect(button(renderCourt(court(2), true, false, true), 'Review mixed group')).not.toContain('disabled=""');
  });
  it('never offers review for a closed, partial or already assigned court', () => {
    for (const value of [court(2, { status: 'disabled' }), court(2, { players: players.slice(0, 1) }), court(2, { players })]) {
      expect(button(renderCourt(value), 'Review group')).toBeUndefined();
    }
    expect(button(renderCourt(court(2, { players })), 'Start')).not.toContain('disabled=""');
  });
});

describe('court-specific match review', () => {
  it('preselects the requested South court rather than the first empty North court', () => {
    const html = renderReview([court(1), court(2)], 2);
    expect(textOf(html)).toContain('Match review');
    expect(html).toContain('<option value="2" selected="">South</option>');
    expect(html).not.toContain('<option value="1" selected="">');
    expect(button(html, 'Assign court')).not.toContain('disabled=""');
  });
  it('requires an explicit new destination when the intended court is no longer available', () => {
    const html = renderReview([court(1), court(2, { status: 'in-play', players })], 2);
    expect(textOf(html)).toContain('Choose another court or Next game.');
    expect(html).toContain('<option value="2" disabled="" selected="">');
    expect(button(html, 'Assign court')).toContain('disabled=""');
    expect(html).not.toContain('<option value="1" selected="">');
  });
  it('does not silently replace a removed destination with a different court', () => {
    const html = renderReview([court(1)], 2);
    expect(html).toContain('Court 2 — unavailable');
    expect(button(html, 'Assign court')).toContain('disabled=""');
  });
  it('preserves the existing general review when no court was selected', () => {
    const html = renderReview([court(1), court(2)]);
    expect(textOf(html)).toContain('Match review');
    expect(html).toContain('<option value="1" selected="">North</option>');
  });
});

describe('player screen controls', () => {
  it('describes the actual read-only refresh interval without issuing access during static rendering', () => {
    const onCreate = vi.fn(async () => 'https://club.example/#display=fictional-display');
    const html = renderToStaticMarkup(<PlayerScreenDialog onCreate={onCreate} onClose={() => undefined} error={null} />);
    expect(textOf(html)).toContain('Read-only. Updates every 5 seconds.');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Close player screen controls"');
    expect(html).not.toContain('fictional-display');
    expect(onCreate).not.toHaveBeenCalled();
  });
});
