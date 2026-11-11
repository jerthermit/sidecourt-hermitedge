import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';
import { AccessManager, type AccessContext } from './access.js';
import type { AppConfig } from './config.js';
import { Repository } from './db.js';
import { AppError, badRequest } from './errors.js';
import { Matchmaker } from './matchmaker.js';
import { isReportDate } from './reportDate.js';
import { attendanceStatuses, maxCourtCount, playStyles, queueLanes, skillLevels, type Destination, type RosterColumnMapping } from './models.js';

const createPlayerBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  skillLevel: z.enum(skillLevels).default('unrated'),
  skillRating: z.number().min(1).max(6).nullable().default(null),
  playStyle: z.enum(playStyles),
}).strict();

const playerParamsSchema = z.object({ id: z.string().uuid() }).strict();
const rosterImportBodySchema = z.object({
  source: z.string().trim().min(1).max(80),
  rows: z.array(createPlayerBodySchema.extend({
    externalId: z.string().trim().min(1).max(100),
  }).strict()).min(1).max(200),
}).strict();
const rosterImportCommitBodySchema = rosterImportBodySchema.extend({
  updateExisting: z.boolean().optional(),
  revision: z.number().int().nonnegative().optional(),
}).strict();
const attendanceBodySchema = z.object({
  attendance: z.enum(attendanceStatuses),
}).strict();
const proposalParamsSchema = z.object({ id: z.string().uuid() }).strict();
const courtParamsSchema = z.object({
  id: z.coerce.number().int().min(1).max(maxCourtCount),
}).strict();

const destinationSchema: ZodType<Destination> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('holding-pool'),
    index: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal('next-game-pool'),
    lane: z.enum(queueLanes),
  }).strict(),
  z.object({
    type: z.literal('court'),
    courtId: z.number().int().min(1).max(maxCourtCount),
  }).strict(),
]);

const movePlayerBodySchema = z.object({ destination: destinationSchema }).strict();
const reorderBodySchema = z.object({
  playerId: z.string().uuid(),
  targetIndex: z.number().int().nonnegative(),
}).strict();
const mappedColumn = z.string().trim().min(1).max(100).optional();
const rosterMappingSchema = z.object({
  externalId: mappedColumn, name: mappedColumn, skillLevel: mappedColumn,
  skillRating: mappedColumn, playStyle: mappedColumn,
}).strict().refine((mapping) => {
  const columns = Object.values(mapping).filter((column): column is string => column !== undefined)
    .map((column) => column.toLocaleLowerCase('en-AU'));
  return columns.length === new Set(columns).size;
}, 'Use each CSV column once.').transform((mapping) => Object.fromEntries(
  Object.entries(mapping).filter(([, column]) => column !== undefined),
) as RosterColumnMapping);
const settingsBodySchema = z.object({
  venueName: z.string().trim().min(1).max(80),
  courtCount: z.number().int().min(1).max(maxCourtCount),
  timezone: z.string().min(1).max(80).refine((timezone) => {
    try { new Intl.DateTimeFormat('en-AU', { timeZone: timezone }); return true; } catch { return false; }
  }, 'Use a valid IANA timezone.'),
  gameMode: z.enum(['doubles', 'singles']),
  courtNames: z.array(z.string().trim().min(1).max(40)).min(1).max(maxCourtCount).optional(),
  rotationMode: z.enum(['open', 'skill-banded']).optional(),
  avoidRepeatPartners: z.boolean().optional(),
  rosterMapping: rosterMappingSchema.optional(),
}).strict();
const sessionBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  includePreviousRoster: z.boolean().optional().default(false),
}).strict();
const sessionExportSchema = z.object({
  kind: z.enum(['attendance', 'matches']),
  sessionId: z.string().uuid().optional(),
}).strict();
const dailyReportQuerySchema = z.object({
  date: z.string().refine(isReportDate, 'Choose a valid date (YYYY-MM-DD).'),
}).strict();
const proposalBodySchema = z.object({ allowMixed: z.boolean().default(false) }).strict();
const proposalApplyBodySchema = z.object({
  courtId: z.number().int().min(1).max(maxCourtCount).optional(),
  approveMixed: z.boolean().default(false),
}).strict();
const rotationPlanApplyBodySchema = z.object({
  approveMixed: z.boolean().default(false),
}).strict();
const stagedGroupBodySchema = z.object({
  sessionId: z.string().uuid(),
  lane: z.enum(queueLanes),
  playerIds: z.array(z.string().uuid()).min(2).max(4)
    .refine((ids) => new Set(ids).size === ids.length, 'Choose unique players.'),
  approveMixed: z.boolean().default(false),
}).strict();
const reasonBodySchema = z.object({ reason: z.string().trim().min(3).max(160) }).strict();
const correctionBodySchema = z.object({
  reason: z.string().trim().min(3).max(160),
  playerIds: z.array(z.string().uuid()).min(2).max(4),
  durationSeconds: z.number().int().min(0).max(86_400),
}).strict();

export interface BuildAppOptions {
  config: AppConfig;
  repository?: Repository;
  logger?: boolean;
}

function parseInput<T>(schema: ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
      .join('; ');
    throw badRequest(details);
  }
  return parsed.data;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const repository = options.repository ?? new Repository(options.config.publicDemo ? ':memory:' : options.config.databasePath);
  if (options.config.demoSeed && !options.config.publicDemo) repository.seedRecordingFixture();
  const access = new AccessManager(options.config, repository);
  const requestContexts = new WeakMap<FastifyRequest, AccessContext>();
  const contextFor = (request: FastifyRequest): AccessContext => {
    const context = requestContexts.get(request);
    if (!context) throw new AppError(401, 'UNAUTHORIZED', 'A valid access key is required.');
    access.assertCurrent(context, context.repository);
    return context;
  };
  const repositoryFor = (request: FastifyRequest): Repository => contextFor(request).repository;
  const assertRosterCapacity = (currentRepository: Repository, additionalPlayers: number): void => {
    if (options.config.publicDemo && currentRepository.getPlayerCount() + additionalPlayers > 500) {
      throw new AppError(409, 'ROSTER_LIMIT', 'This board supports up to 500 players.');
    }
  };
  const app = Fastify({
    logger: options.logger ? { redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    bodyLimit: options.config.bodyLimit,
    trustProxy: (_address: string, hop: number) => hop < (options.config.trustProxyHops ?? 1),
  });
  const matchmaker = new Matchmaker();

  // CORS response headers alone do not prevent simple cross-origin writes.
  // Check every route spelling before visitor allocation or other handlers run.
  app.addHook('onRequest', async (request) => {
    const origin = request.headers.origin;
    if (origin !== undefined && !options.config.corsOrigins.includes(origin)) {
      throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This browser origin is not allowed.');
    }
  });

  await app.register(cors, {
    origin: options.config.corsOrigins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: options.config.rateLimitMax,
    timeWindow: options.config.rateLimitWindow,
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    // This service only returns API/health data, including encoded route aliases.
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  // Authenticate before parsing bodies, after onRequest rate limits have counted
  // failed credentials. Use the registered path because Fastify decodes aliases.
  app.addHook('preParsing', async (request, _reply, payload) => {
    const pathname = request.routeOptions.url ?? request.url.split('?')[0];
    if (!pathname?.startsWith('/api') || request.method === 'OPTIONS') return payload;
    if (options.config.publicDemo && pathname === '/api/visitor-sessions' && request.method === 'POST') return payload;
    const context = pathname === '/api/display' && request.method === 'GET'
      ? access.resolveDisplay(request.headers.authorization)
      : access.resolveOperator(request.headers.authorization);
    requestContexts.set(request, context);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer');
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    const fastifyError = error as { statusCode?: number; code?: string };
    if (fastifyError.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please retry shortly.' },
      });
    }
    if (fastifyError.statusCode === 400) {
      return reply.status(400).send({
        error: { code: 'INVALID_REQUEST', message: 'The request body is invalid.' },
      });
    }
    if (fastifyError.statusCode === 415) {
      return reply.status(415).send({
        error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Use a supported request content type.' },
      });
    }
    if (
      fastifyError.statusCode === 413
      || fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
    ) {
      return reply.status(413).send({
        error: { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' },
      });
    }
    request.log.error({ err: error }, 'Unhandled request failure');
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'The operation could not be confirmed. Refresh to check the latest state before retrying.',
      },
    });
  });

  app.setNotFoundHandler((_request, reply) => reply.status(404).send({
    error: { code: 'NOT_FOUND', message: 'Route not found.' },
  }));

  app.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
    try {
      if (!repository.ping()) throw new Error('Database health check failed.');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });

  app.post('/api/visitor-sessions', {
    config: { rateLimit: { max: 10, timeWindow: '1 hour' } },
  }, async (_request, reply) => reply.status(201).send(access.createVisitor()));

  app.post('/api/visitor-reset', async (request) => access.resetVisitor(contextFor(request)));

  app.get('/api/state', async (request) => repositoryFor(request).getSnapshot());

  app.post('/api/settings', async (request) => {
    const currentRepository = repositoryFor(request);
    const body = parseInput(settingsBodySchema, request.body);
    const current = currentRepository.getSettings();
    return currentRepository.updateSettings({
      ...current, ...body,
      courtNames: body.courtNames ?? Array.from({ length: body.courtCount }, (_, index) =>
        current.courtNames[index] ?? `Court ${index + 1}`),
      rotationMode: body.rotationMode ?? current.rotationMode,
      avoidRepeatPartners: body.avoidRepeatPartners ?? current.avoidRepeatPartners,
      rosterMapping: body.rosterMapping ?? current.rosterMapping,
    });
  });

  app.post('/api/roster/mapping', async (request) => {
    const { mapping } = parseInput(z.object({ mapping: rosterMappingSchema }).strict(), request.body);
    return repositoryFor(request).updateRosterMapping(mapping);
  });

  app.post('/api/sessions', async (request, reply) => {
    const { name, includePreviousRoster } = parseInput(sessionBodySchema, request.body);
    return reply.status(201).send(repositoryFor(request).startSession(name, includePreviousRoster));
  });

  app.post('/api/sessions/close', async (request) => repositoryFor(request).closeSession());

  app.get('/api/sessions/:id/report', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    return repositoryFor(request).getSessionReport(id);
  });

  app.get('/api/reports/daily', async (request) => {
    const { date } = parseInput(dailyReportQuerySchema, request.query);
    return repositoryFor(request).getDailyReport(date);
  });

  app.get('/api/sessions/export', async (request, reply) => {
    const { kind, sessionId } = parseInput(sessionExportSchema, request.query);
    const csv = repositoryFor(request).exportSession(kind, sessionId);
    return reply.type('text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="session-${kind}.csv"`).send(csv);
  });

  app.post('/api/display-access', async (request, reply) => reply.status(201).send(
    access.createDisplay(contextFor(request)),
  ));

  app.get('/api/display', async (request) => {
    const snapshot = repositoryFor(request).getSnapshot();
    const playerIdentity = ({ id, name }: { id: string; name: string }) => ({ id, name });
    return {
      settings: {
        venueName: snapshot.settings.venueName, courtCount: snapshot.settings.courtCount,
        timezone: snapshot.settings.timezone, gameMode: snapshot.settings.gameMode,
        courtNames: snapshot.settings.courtNames, rotationMode: snapshot.settings.rotationMode,
        avoidRepeatPartners: snapshot.settings.avoidRepeatPartners,
      },
      session: snapshot.session,
      courts: snapshot.courts.map(({ id, name, status, players, gameStartedAt, timeElapsed }) => ({
        id, name, status, players: players.map(playerIdentity), gameStartedAt, timeElapsed,
      })),
      nextGamePool: {
        beginner: snapshot.nextGamePool.beginner.map(playerIdentity),
        intermediate: snapshot.nextGamePool.intermediate.map(playerIdentity),
        advanced: snapshot.nextGamePool.advanced.map(playerIdentity),
        mixed: snapshot.nextGamePool.mixed.map(playerIdentity),
      },
      holdingPool: snapshot.holdingPool.map(playerIdentity),
    };
  });

  const rosterRouteOptions = { bodyLimit: 512 * 1024 };

  app.post('/api/roster/preview', rosterRouteOptions, async (request) => {
    const { source, rows } = parseInput(rosterImportBodySchema, request.body);
    return repositoryFor(request).previewRosterImport(source, rows);
  });

  app.post('/api/roster/import', rosterRouteOptions, async (request) => {
    const { source, rows, updateExisting, revision } = parseInput(rosterImportCommitBodySchema, request.body);
    const currentRepository = repositoryFor(request);
    if (options.config.publicDemo) {
      const preview = currentRepository.previewRosterImport(source, rows);
      assertRosterCapacity(currentRepository, preview.newCount);
    }
    return currentRepository.importRoster(source, rows, { updateExisting, revision });
  });

  app.post('/api/players', async (request, reply) => {
    const body = parseInput(createPlayerBodySchema, request.body);
    const currentRepository = repositoryFor(request);
    assertRosterCapacity(currentRepository, 1);
    const snapshot = currentRepository.createPlayer(body);
    return reply.status(201).send(snapshot);
  });

  app.delete('/api/players/:id', async (request) => {
    const { id } = parseInput(playerParamsSchema, request.params);
    return repositoryFor(request).removePlayer(id);
  });

  app.post('/api/players/:id/attendance', async (request) => {
    const { id } = parseInput(playerParamsSchema, request.params);
    const { attendance } = parseInput(attendanceBodySchema, request.body);
    return repositoryFor(request).setAttendance(id, attendance);
  });

  app.post('/api/players/:id/move', async (request) => {
    const { id } = parseInput(playerParamsSchema, request.params);
    const { destination } = parseInput(movePlayerBodySchema, request.body);
    return repositoryFor(request).movePlayer(id, destination);
  });

  app.post('/api/holding/reorder', async (request) => {
    const { playerId, targetIndex } = parseInput(reorderBodySchema, request.body);
    return repositoryFor(request).reorderHoldingPool(playerId, targetIndex);
  });

  app.post('/api/courts/:id/start', async (request) => {
    const { id } = parseInput(courtParamsSchema, request.params);
    return repositoryFor(request).startGame(id);
  });

  app.post('/api/courts/:id/assign-staged', async (request) => {
    const { id } = parseInput(courtParamsSchema, request.params);
    const { sessionId, lane, playerIds, approveMixed } = parseInput(stagedGroupBodySchema, request.body);
    return repositoryFor(request).assignStagedGroup(id, sessionId, lane, playerIds, approveMixed);
  });

  app.post('/api/courts/:id/end', async (request) => {
    const { id } = parseInput(courtParamsSchema, request.params);
    return repositoryFor(request).endGame(id);
  });

  app.post('/api/courts/:id/void', async (request) => {
    const { id } = parseInput(courtParamsSchema, request.params);
    const { reason } = parseInput(reasonBodySchema, request.body);
    return repositoryFor(request).voidActiveGame(id, reason);
  });

  app.post('/api/games/:id/void', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    const { reason } = parseInput(reasonBodySchema, request.body);
    return repositoryFor(request).voidRecordedGame(id, reason);
  });

  app.post('/api/games/:id/correct', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    const body = parseInput(correctionBodySchema, request.body);
    return repositoryFor(request).correctRecordedGame(id, body);
  });

  app.post('/api/courts/:id/toggle', async (request) => {
    const { id } = parseInput(courtParamsSchema, request.params);
    return repositoryFor(request).toggleCourtStatus(id);
  });

  app.post('/api/rotation-plans', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { allowMixed } = parseInput(proposalBodySchema, request.body ?? {});
    return reply.status(201).send(repositoryFor(request).createRotationPlan(allowMixed));
  });

  app.get('/api/rotation-plans/current', async (request) =>
    repositoryFor(request).getCurrentRotationPlan());

  app.post('/api/rotation-plans/:id/reject', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    return repositoryFor(request).rejectRotationPlan(id);
  });

  app.post('/api/rotation-plans/:id/apply', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    const { approveMixed } = parseInput(rotationPlanApplyBodySchema, request.body ?? {});
    const currentRepository = repositoryFor(request);
    currentRepository.applyRotationPlan(id, approveMixed);
    return currentRepository.getSnapshot();
  });

  app.post('/api/match-proposals', async (request, reply) => {
    const { allowMixed } = parseInput(proposalBodySchema, request.body ?? {});
    const context = contextFor(request);
    const currentRepository = context.repository;
    const settings = currentRepository.getSettings();
    const groupSize = settings.gameMode === 'singles' ? 2 : 4;
    const matchContext = currentRepository.getMatchContext(allowMixed);
    const candidates = matchContext.candidates;
    const draft = await matchmaker.propose(
      candidates, groupSize, matchContext.previousTeams, settings.avoidRepeatPartners,
    );
    access.assertCurrent(context, currentRepository);
    const proposal = currentRepository.persistProposal({
      ...draft, mixed: matchContext.mixed, contextRevision: matchContext.revision,
    });
    return reply.status(201).send(proposal);
  });

  app.post('/api/match-proposals/:id/apply', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    const { courtId, approveMixed } = parseInput(proposalApplyBodySchema, request.body ?? {});
    return repositoryFor(request).applyProposal(id, courtId, approveMixed);
  });

  app.post('/api/match-proposals/:id/reject', async (request) => {
    const { id } = parseInput(proposalParamsSchema, request.params);
    return repositoryFor(request).rejectProposal(id);
  });

  app.addHook('onClose', async () => access.close());
  return app;
}
