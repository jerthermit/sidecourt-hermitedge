import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const privateEnvironment = { OPERATOR_ACCESS_KEY: 'private-configuration-test-key' };
const railwayEnvironment = { ...privateEnvironment, RAILWAY_SERVICE_ID: 'service-id' };
const railwayMarkers = ['RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID'];

describe('private Railway database configuration', () => {
  it.each(railwayMarkers)('recognizes %s and requires a volume', (marker) => {
    expect(() => loadConfig({ ...privateEnvironment, [marker]: 'railway-id' }, '/app/server'))
      .toThrow('RAILWAY_VOLUME_MOUNT_PATH');
  });

  it.each([undefined, '', '   ', 'data', './data', '../data'])(
    'rejects missing, blank or relative volume mount %s', (mountPath) => {
      expect(() => loadConfig({ ...railwayEnvironment, RAILWAY_VOLUME_MOUNT_PATH: mountPath }, '/app/server'))
        .toThrow('absolute RAILWAY_VOLUME_MOUNT_PATH');
    },
  );

  it.each([
    { configuredPath: undefined, workingDirectory: '/app/server', expected: '/data/pickleball.db' },
    { configuredPath: '/data/club.db', workingDirectory: '/app/server', expected: '/data/club.db' },
    { configuredPath: '/data/nested/club.db', workingDirectory: '/app/server', expected: '/data/nested/club.db' },
    { configuredPath: 'nested/club.db', workingDirectory: '/data', expected: '/data/nested/club.db' },
    { configuredPath: '../club.db', workingDirectory: '/data/nested', expected: '/data/club.db' },
  ])('permits a database within the volume: $configuredPath', ({ configuredPath, workingDirectory, expected }) => {
    expect(loadConfig({
      ...railwayEnvironment, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATABASE_PATH: configuredPath,
    }, workingDirectory).databasePath).toBe(expected);
  });

  it.each([
    ':memory:', '/data', '/data/nested/..', '/outside/club.db',
    '/data/../outside.db', '../outside.db', '/data-other/club.db',
  ])('rejects a database outside or equal to the volume: %s', (databasePath) => {
    expect(() => loadConfig({
      ...railwayEnvironment, RAILWAY_VOLUME_MOUNT_PATH: '/data', DATABASE_PATH: databasePath,
    }, '/data')).toThrow('DATABASE_PATH must be inside RAILWAY_VOLUME_MOUNT_PATH');
  });
});

describe('unchanged public and local configuration', () => {
  it.each(railwayMarkers)('allows public mode without a volume when %s is present', (marker) => {
    expect(loadConfig({ PUBLIC_DEMO: 'true', [marker]: 'railway-id' }, '/app/server').publicDemo).toBe(true);
  });

  it('allows local in-memory and relative database paths', () => {
    expect(loadConfig({ ...privateEnvironment, DATABASE_PATH: ':memory:' }, '/app/server').databasePath)
      .toBe(':memory:');
    expect(loadConfig({ ...privateEnvironment, DATABASE_PATH: 'data/local.db' }, '/app/server').databasePath)
      .toBe('/app/server/data/local.db');
  });

  it('does not treat empty or whitespace-only Railway markers as a deployment', () => {
    expect(loadConfig({
      ...privateEnvironment, DATABASE_PATH: ':memory:',
      RAILWAY_SERVICE_ID: '', RAILWAY_PROJECT_ID: '   ', RAILWAY_ENVIRONMENT_ID: '',
    }, '/app/server').databasePath).toBe(':memory:');
  });
});
