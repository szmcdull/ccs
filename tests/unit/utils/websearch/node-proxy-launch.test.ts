import { describe, expect, it } from 'bun:test';
import {
  buildNodeWebSearchCommand,
  getNodeWebSearchArgs,
  getNodeWebSearchEnv,
  supportsNodeEnvProxyFlag,
} from '../../../../src/utils/websearch/node-proxy-launch';

describe('node websearch proxy launch helpers', () => {
  it('detects when the current Node runtime supports --use-env-proxy', () => {
    expect(supportsNodeEnvProxyFlag(new Set(['--use-env-proxy']))).toBe(true);
    expect(supportsNodeEnvProxyFlag(new Set(['--inspect']))).toBe(false);
  });

  it('prepends --use-env-proxy to node args when the flag is supported', () => {
    expect(getNodeWebSearchArgs('/tmp/websearch.cjs', new Set(['--use-env-proxy']))).toEqual([
      '--use-env-proxy',
      '/tmp/websearch.cjs',
    ]);
    expect(buildNodeWebSearchCommand('/tmp/websearch.cjs', new Set(['--use-env-proxy']))).toBe(
      'node --use-env-proxy "/tmp/websearch.cjs"'
    );
    expect(getNodeWebSearchEnv(new Set(['--use-env-proxy']))).toEqual({});
  });

  it('falls back to NODE_USE_ENV_PROXY when the CLI flag is unavailable', () => {
    expect(getNodeWebSearchArgs('/tmp/websearch.cjs', new Set(['--inspect']))).toEqual([
      '/tmp/websearch.cjs',
    ]);
    expect(buildNodeWebSearchCommand('/tmp/websearch.cjs', new Set(['--inspect']))).toBe(
      'node "/tmp/websearch.cjs"'
    );
    expect(getNodeWebSearchEnv(new Set(['--inspect']))).toEqual({
      NODE_USE_ENV_PROXY: '1',
    });
  });
});
