import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './config.js';
import { Repository } from './db.js';
import { AppError, conflict, unauthorized } from './errors.js';

export interface AccessContext {
  repository: Repository;
  expiresAt: number;
  visitor: boolean;
  closed: boolean;
}

interface DisplayAccess {
  context: AccessContext;
  expiresAt: number;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ') || header.length > 520) throw unauthorized();
  return header.slice(7);
}

function equalKey(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
}

/** Process-local access grants. Public visitors never share the persistent club database. */
export class AccessManager {
  private readonly visitors = new Map<string, AccessContext>();
  private readonly displays = new Map<string, DisplayAccess>();
  private readonly privateContext: AccessContext;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly config: AppConfig, repository: Repository) {
    this.privateContext = {
      repository, expiresAt: Number.POSITIVE_INFINITY, visitor: false, closed: false,
    };
    this.cleanupTimer = setInterval(() => this.prune(), 60_000);
    this.cleanupTimer.unref();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, context] of this.visitors) {
      if (context.expiresAt > now) continue;
      context.closed = true;
      context.repository.close();
      this.visitors.delete(key);
    }
    for (const [key, access] of this.displays) {
      if (access.expiresAt <= now || access.context.closed) this.displays.delete(key);
    }
  }

  private createVisitorRepository(): Repository {
    const repository = new Repository(':memory:');
    try {
      repository.seedPublicFixture();
      return repository;
    } catch (error) {
      repository.close();
      throw error;
    }
  }

  createVisitor(): { accessKey: string; expiresAt: number } {
    if (!this.config.publicDemo) throw new AppError(404, 'NOT_FOUND', 'Route not found.');
    this.prune();
    if (this.visitors.size >= (this.config.maxVisitors ?? 30)) {
      throw new AppError(503, 'VISITOR_CAPACITY', 'All visitor sessions are in use. Please try again later.');
    }
    const repository = this.createVisitorRepository();
    const accessKey = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + (this.config.visitorTtlMs ?? 120 * 60_000);
    this.visitors.set(digest(accessKey), {
      repository, expiresAt, visitor: true, closed: false,
    });
    return { accessKey, expiresAt };
  }

  resolveOperator(header: string | undefined): AccessContext {
    this.prune();
    const token = bearer(header);
    if (this.config.publicDemo) {
      const context = this.visitors.get(digest(token));
      if (!context || context.closed) throw unauthorized();
      return context;
    }
    if (!this.config.operatorAccessKey || !equalKey(token, this.config.operatorAccessKey)) throw unauthorized();
    return this.privateContext;
  }

  assertCurrent(context: AccessContext, repository: Repository): void {
    this.prune();
    if (context.closed || context.expiresAt <= Date.now()) throw unauthorized();
    if (context.repository !== repository) throw conflict('The board was reset. Refresh before trying again.');
  }

  resetVisitor(context: AccessContext) {
    if (!this.config.publicDemo || !context.visitor) {
      throw new AppError(403, 'FORBIDDEN', 'This board cannot be reset.');
    }
    this.assertCurrent(context, context.repository);
    const replacement = this.createVisitorRepository();
    const previous = context.repository;
    context.repository = replacement;
    for (const [key, access] of this.displays) {
      if (access.context === context) this.displays.delete(key);
    }
    previous.close();
    // A reset keeps the original access expiry.
    return replacement.getSnapshot();
  }

  createDisplay(context: AccessContext): { accessKey: string; expiresAt: number } {
    this.assertCurrent(context, context.repository);
    const owned = [...this.displays].filter(([, access]) => access.context === context);
    // A handful of court screens is sufficient; repeated issuance cannot grow memory forever.
    if (owned.length >= 5) this.displays.delete(owned[0]![0]);
    const accessKey = randomBytes(32).toString('base64url');
    const expiresAt = Math.min(Date.now() + 4 * 60 * 60_000, context.expiresAt);
    this.displays.set(digest(accessKey), { context, expiresAt });
    return { accessKey, expiresAt };
  }

  resolveDisplay(header: string | undefined): AccessContext {
    this.prune();
    const access = this.displays.get(digest(bearer(header)));
    if (!access || access.context.closed) throw unauthorized();
    return access.context;
  }

  close(): void {
    clearInterval(this.cleanupTimer);
    for (const context of this.visitors.values()) {
      context.closed = true;
      context.repository.close();
    }
    this.visitors.clear();
    this.displays.clear();
    this.privateContext.closed = true;
    this.privateContext.repository.close();
  }
}
