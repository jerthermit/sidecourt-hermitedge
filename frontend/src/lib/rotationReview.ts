import type { RotationPlan } from '../types/models';

export const rotationApprovalKey = (plan: RotationPlan): string =>
  JSON.stringify([plan.sessionId, plan.id, plan.revision]);

export function canApproveRotation(plan: RotationPlan | null, error: string | null,
  approvedKey: string | null, now: number): boolean {
  return plan !== null && plan.status === 'pending' && plan.expiresAt > now
    && plan.assignments.length > 0 && !error
    && (!plan.assignments.some((assignment) => assignment.mixed)
      || approvedKey === rotationApprovalKey(plan));
}
