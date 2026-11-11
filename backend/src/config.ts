import path from 'node:path';
import { z } from 'zod';

const positiveInteger = (fallback: number) =>
  z.preprocess(
    (value) => (value === undefined || value === '' ? fallback : Number(value)),
    z.number().int().positive(),
  );

const boundedInteger = (fallback: number, maximum: number) => z.preprocess(
  (value) => (value === undefined || value === '' ? fallback : Number(value)),
  z.number().int().positive().max(maximum),
);
const booleanSetting = () => z.enum(['true', 'false'])
  .default('false').transform((value) => value === 'true');

const environmentSchema = z.object({
  PORT: positiveInteger(3001),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  OPERATOR_ACCESS_KEY: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_PATH: z.string().trim().optional(),
  RAILWAY_VOLUME_MOUNT_PATH: z.string().trim().optional(),
  REQUEST_BODY_LIMIT_BYTES: positiveInteger(65_536),
  RATE_LIMIT_MAX: positiveInteger(120),
  RATE_LIMIT_WINDOW: z.string().trim().min(1).default('1 minute'),
  DEMO_SEED: booleanSetting(),
  PUBLIC_DEMO: booleanSetting(),
  VISITOR_TTL_MINUTES: boundedInteger(120, 1440),
  MAX_VISITORS: boundedInteger(30, 100),
  TRUST_PROXY_HOPS: z.preprocess(
    (value) => (value === undefined || value === '' ? 1 : Number(value)),
    z.number().int().min(0).max(2),
  ),
}).superRefine((env, context) => {
  if (!env.PUBLIC_DEMO && (env.OPERATOR_ACCESS_KEY.trim().length < 16
    || env.OPERATOR_ACCESS_KEY.length > 512 || /[\r\n]/.test(env.OPERATOR_ACCESS_KEY))) {
    context.addIssue({ code: 'custom', path: ['OPERATOR_ACCESS_KEY'],
      message: 'Must contain 16–512 characters, excluding surrounding whitespace, without line breaks in private mode.' });
  }
});

export interface AppConfig {
  host: string;
  port: number;
  operatorAccessKey: string;
  corsOrigins: string[];
  databasePath: string;
  bodyLimit: number;
  rateLimitMax: number;
  rateLimitWindow: string;
  demoSeed: boolean;
  publicDemo?: boolean;
  visitorTtlMs?: number;
  maxVisitors?: number;
  trustProxyHops?: number;
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }

  const env = parsed.data;
  const configuredPath = env.DATABASE_PATH
    ?? (env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, 'pickleball.db')
      : path.join('data', 'pickleball.db'));
  const databasePath = configuredPath === ':memory:'
    ? configuredPath
    : path.resolve(workingDirectory, configuredPath);
  const privateRailway = !env.PUBLIC_DEMO && [
    environment.RAILWAY_SERVICE_ID, environment.RAILWAY_PROJECT_ID, environment.RAILWAY_ENVIRONMENT_ID,
  ].some((value) => Boolean(value?.trim()));
  if (privateRailway) {
    const mountPath = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mountPath || !path.isAbsolute(mountPath)) {
      throw new Error('Invalid server configuration: private Railway deployments require an absolute RAILWAY_VOLUME_MOUNT_PATH');
    }
    const relativePath = path.relative(path.resolve(mountPath), databasePath);
    if (databasePath === ':memory:' || relativePath === '' || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error('Invalid server configuration: DATABASE_PATH must be inside RAILWAY_VOLUME_MOUNT_PATH in private Railway mode');
    }
  }
  const corsOrigins = env.CORS_ORIGINS
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (corsOrigins.length === 0) {
    throw new Error('Invalid server configuration: CORS_ORIGINS must include an origin');
  }
  for (const origin of corsOrigins) {
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(origin); } catch {
      throw new Error('Invalid server configuration: CORS_ORIGINS must contain exact HTTP(S) origins');
    }
    if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin) {
      throw new Error('Invalid server configuration: CORS_ORIGINS must contain exact HTTP(S) origins');
    }
  }

  return {
    host: env.HOST,
    port: env.PORT,
    operatorAccessKey: env.OPERATOR_ACCESS_KEY,
    corsOrigins,
    databasePath,
    bodyLimit: env.REQUEST_BODY_LIMIT_BYTES,
    rateLimitMax: env.RATE_LIMIT_MAX,
    rateLimitWindow: env.RATE_LIMIT_WINDOW,
    demoSeed: env.DEMO_SEED,
    publicDemo: env.PUBLIC_DEMO,
    visitorTtlMs: env.VISITOR_TTL_MINUTES * 60_000,
    maxVisitors: env.MAX_VISITORS,
    trustProxyHops: env.TRUST_PROXY_HOPS,
  };
}
