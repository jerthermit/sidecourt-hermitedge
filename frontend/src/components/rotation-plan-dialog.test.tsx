import type { ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Player, RotationPlan } from '../types/models';
import { RotationPlanDialog } from './RotationPlanDialog';
import { canApproveRotation, rotationApprovalKey } from '../lib/rotationReview';

const player = (id: string, name: string, rating: number | null, gamesPlayed?: number): Player => ({
  id, name, skillLevel: rating === null ? 'unrated' : 'intermediate', skillRating: rating,
  playStyle: 'Balanced', attendance: 'ready', source: null, externalId: null,
  location: { type: 'holding-pool', index: Number(id.replace(/\D/g, '')) || 0 }, createdAt: 1,
  gamesPlayed,
});

const players = [
  player('p1', 'Alex Morgan', 3.4, 1),
  player('p2', 'Sam Taylor', null, 0),
  player('p3', 'Jordan Lee', 3.2, 2),
  player('p4', 'Casey Martin', 3.5, 1),
];

const makePlan = (overrides: Partial<RotationPlan> = {}): RotationPlan => ({
  id: 'rotation-1', sessionId: 'session-1', revision: 2, createdAt: Date.now() - 1_000,
  expiresAt: Date.now() + 60_000, status: 'pending', allowMixed: false, canMix: true,
  policy: { rotationMode: 'skill-banded', avoidRepeatPartners: true },
  assignments: [{
    courtId: 1, courtName: 'Garden Court', players, mixed: false,
    metrics: { ratingDifference: null, repeatPartners: 0, repeatOpponents: 1 },
  }],
  waiting: [player('p5', 'Riley Chen', 3.1, 3)], blockedReason: null,
  ...overrides,
});

const props = (overrides: Partial<ComponentProps<typeof RotationPlanDialog>> = {}): ComponentProps<typeof RotationPlanDialog> => ({
  plan: makePlan(), busy: false, error: null, onRefresh: vi.fn(async () => true),
  onApprove: vi.fn(async () => true), onClose: vi.fn(), returnFocusTo: null, ...overrides,
});
const renderDialog = (overrides: Partial<ComponentProps<typeof RotationPlanDialog>> = {}): string =>
  renderToStaticMarkup(<RotationPlanDialog {...props(overrides)} />);
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const buttonFor = (markup: string, label: string): string => {
  const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((candidate) => textOf(candidate) === label || candidate.includes(`aria-label="${label}"`));
  expect(button, `Expected a ${label} control`).toBeDefined();
  return button!;
};
const teamNames = (markup: string, label: string): string[] => {
  const list = markup.match(new RegExp(`aria-label="${label}">([\\s\\S]*?)<\\/ol>`))?.[1];
  expect(list).toBeDefined();
  return [...list!.matchAll(/<li><strong>([^<]*)<\/strong>/g)].map((match) => match[1]!);
};

describe('rotation plan review', () => {
  it('preserves the ordered teams and readable court name', () => {
    const plan = makePlan();
    const assignment = plan.assignments[0]!;
    assignment.players = [players[0]!, player('p2', 'Sam Taylor', 3.0, 0), ...players.slice(2)];
    assignment.metrics.ratingDifference = 0.3;
    const html = renderDialog({ plan });
    expect(textOf(html)).toContain('Garden Court');
    expect(teamNames(html, 'Garden Court, Team 1')).toEqual(['Alex Morgan', 'Sam Taylor']);
    expect(teamNames(html, 'Garden Court, Team 2')).toEqual(['Jordan Lee', 'Casey Martin']);
    expect(textOf(html)).toContain('Team rating gap 0.3 · 1 repeat opponent');
    expect(buttonFor(html, 'Assign 1 court')).not.toContain('disabled=""');
  });

  it('shows games and repeat opponents while suppressing a gap for incomplete ratings', () => {
    const plan = makePlan();
    plan.assignments[0]!.metrics.ratingDifference = 0.3;
    const html = renderDialog({ plan });
    expect(html).toContain('aria-label="Local rating not recorded"');
    expect(textOf(html)).toContain('Rating —');
    expect(textOf(html)).toContain('0 games');
    expect(textOf(html)).toContain('2 games');
    expect(textOf(html)).toContain('1 repeat opponent');
    expect(textOf(html)).not.toContain('Team rating gap');
    expect(textOf(html)).not.toContain('3.5</span><span>0 games');
  });

  it('offers a deliberate mixed review from a strict plan without enabling mixed approval', () => {
    const html = renderDialog();
    expect(buttonFor(html, 'Review mixed groups')).not.toContain('disabled=""');
    expect(html).not.toContain('type="checkbox"');
    expect(textOf(html)).toContain('Skill-banded rotation');
    expect(textOf(html)).not.toContain('Avoid repeat partners');
  });

  it('requires an unchecked approval for a plan containing mixed groups', () => {
    const mixed = makePlan({ allowMixed: true, assignments: [{
      courtId: 2, courtName: 'Harbour Court', players, mixed: true,
      metrics: { ratingDifference: null, repeatPartners: 0, repeatOpponents: 0 },
    }] });
    const html = renderDialog({ plan: mixed });
    expect(textOf(html)).toContain('Approve mixed groups');
    expect(html).toMatch(/<input type="checkbox"\s*\/>/);
    expect(html).not.toContain('checked=""');
    expect(buttonFor(html, 'Assign 1 court')).toContain('disabled=""');
    expect(html).not.toContain('Review mixed groups');
  });

  it('shows the authoritative blocked reason and actual waiting names without an assignment action', () => {
    const plan = makePlan({ assignments: [], blockedReason: 'Two more rated players are needed for a complete band.',
      waiting: [players[0]!, players[1]!] });
    const html = renderDialog({ plan });
    expect(textOf(html)).toContain('Two more rated players are needed for a complete band.');
    expect(textOf(html)).toContain('Waiting 2');
    expect(textOf(html)).toContain('Alex Morgan');
    expect(textOf(html)).toContain('Sam Taylor');
    expect(buttonFor(html, 'Refresh plan')).not.toContain('disabled=""');
    expect(html).not.toContain('Assign 0 courts');
  });

  it('keeps complete court assignments approvable while the remaining wait is explained', () => {
    const html = renderDialog({ plan: makePlan({ blockedReason: 'The remaining skill band needs two more players.' }) });
    expect(html).toContain('Remaining courts: The remaining skill band needs two more players.');
    expect(textOf(html)).toContain('The remaining skill band needs two more players.');
    expect(buttonFor(html, 'Assign 1 court')).not.toContain('disabled=""');
    expect(textOf(html)).not.toContain('Refresh plan');
  });

  it('ties mixed approval to the exact session, plan and revision', () => {
    const plan = makePlan();
    plan.assignments[0]!.mixed = true;
    const key = rotationApprovalKey(plan);
    expect(canApproveRotation(plan, null, key, Date.now())).toBe(true);
    for (const refreshed of [
      { ...plan, revision: plan.revision + 1 },
      { ...plan, id: 'new-plan' },
      { ...plan, sessionId: 'new-session' },
    ]) expect(canApproveRotation(refreshed, null, key, Date.now())).toBe(false);
  });

  it('rechecks real time at approval even if the displayed clock has not ticked', () => {
    const plan = makePlan({ expiresAt: 1000 });
    expect(canApproveRotation(plan, null, null, 999)).toBe(true);
    expect(canApproveRotation(plan, null, null, 1000)).toBe(false);
    expect(canApproveRotation(plan, null, null, 1100)).toBe(false);
    expect(canApproveRotation(plan, 'Refresh required.', null, 999)).toBe(false);
  });

  it('disables assignment after expiry and exposes refresh', () => {
    const html = renderDialog({ plan: makePlan({ expiresAt: Date.now() - 1, status: 'pending' }) });
    expect(textOf(html)).toContain('Plan expired.');
    expect(buttonFor(html, 'Assign 1 court')).toContain('disabled=""');
    expect(buttonFor(html, 'Refresh plan')).not.toContain('disabled=""');
    expect(html).not.toContain('role="timer"');
  });

  it('provides a labelled native dialog, timer and accessible close control without side effects on render', () => {
    const value = props();
    const html = renderToStaticMarkup(<RotationPlanDialog {...value} />);
    expect(html).toMatch(/<dialog[^>]*aria-labelledby=/);
    expect(html).toContain('role="timer"');
    expect(buttonFor(html, 'Close rotation plan')).not.toContain('disabled=""');
    expect(value.onRefresh).not.toHaveBeenCalled();
    expect(value.onApprove).not.toHaveBeenCalled();
    expect(value.onClose).not.toHaveBeenCalled();
  });

  it('keeps retry and close available for a load error', () => {
    const html = renderDialog({ plan: null, error: 'Rotation state changed. Refresh the plan.' });
    expect(html).toContain('role="alert"');
    expect(textOf(html)).toContain('Rotation state changed. Refresh the plan.');
    expect(buttonFor(html, 'Refresh plan')).not.toContain('disabled=""');
    expect(buttonFor(html, 'Close')).not.toContain('disabled=""');
  });
});
