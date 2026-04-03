/**
 * Helpers for launching Node-based WebSearch runtimes with env proxy support.
 */

export function supportsNodeEnvProxyFlag(
  flags: Pick<ReadonlySet<string>, 'has'> | undefined = process.allowedNodeEnvironmentFlags
): boolean {
  return flags?.has('--use-env-proxy') === true;
}

export function getNodeWebSearchArgs(
  scriptPath: string,
  flags: Pick<ReadonlySet<string>, 'has'> | undefined = process.allowedNodeEnvironmentFlags
): string[] {
  return supportsNodeEnvProxyFlag(flags) ? ['--use-env-proxy', scriptPath] : [scriptPath];
}

export function getNodeWebSearchEnv(
  flags: Pick<ReadonlySet<string>, 'has'> | undefined = process.allowedNodeEnvironmentFlags
): Record<string, string> {
  return supportsNodeEnvProxyFlag(flags) ? {} : { NODE_USE_ENV_PROXY: '1' };
}

export function buildNodeWebSearchCommand(
  scriptPath: string,
  flags: Pick<ReadonlySet<string>, 'has'> | undefined = process.allowedNodeEnvironmentFlags
): string {
  const args = getNodeWebSearchArgs(scriptPath, flags).map((arg) =>
    arg.startsWith('--') ? arg : `"${arg}"`
  );
  return `node ${args.join(' ')}`;
}
