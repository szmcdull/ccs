import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { EventEmitter } from 'events';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getNodeWebSearchArgs, getNodeWebSearchEnv } from '../../../src/utils/websearch/node-proxy-launch';

type SpawnCall = {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
};

const STEERING_PROMPT_SNIPPET = 'prefer the CCS MCP tool WebSearch instead of Bash/curl/http fetches';
const spawnCalls: SpawnCall[] = [];
const originalPlatform = process.platform;
let baselineSigintListeners: Array<(...args: unknown[]) => void> = [];
let baselineSigtermListeners: Array<(...args: unknown[]) => void> = [];
let baselineSighupListeners: Array<(...args: unknown[]) => void> = [];
let originalCcsHome: string | undefined;
let originalCcsClaudePath: string | undefined;
let originalDisableAutoUpdater: string | undefined;
const realSpawn = childProcess.spawn.bind(childProcess);
const realSpawnSync = childProcess.spawnSync.bind(childProcess);
const realExecSync = childProcess.execSync.bind(childProcess);

function createMockChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  pid: number;
  unref: () => EventEmitter;
  kill: () => boolean;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    killed: boolean;
    pid: number;
    unref: () => EventEmitter;
    kill: () => boolean;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.pid = process.pid;
  child.unref = () => child;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 1;
    return true;
  };

  return child;
}

function shouldMockCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return normalized.includes('claude');
}

function registerChildProcessMock(): void {
  mock.module('child_process', () => ({
    ...childProcess,
    spawn: (...spawnArgs: unknown[]) => {
      const command = String(spawnArgs[0] ?? '');
      const maybeArgs = spawnArgs[1];
      const args = Array.isArray(maybeArgs) ? (maybeArgs as string[]) : [];
      const options = (Array.isArray(maybeArgs) ? spawnArgs[2] : spawnArgs[1]) as
        | Record<string, unknown>
        | undefined;

      if (!shouldMockCommand(command)) {
        return realSpawn(command, args, options as Parameters<typeof childProcess.spawn>[2]);
      }

      spawnCalls.push({ command, args, options });

      const child = createMockChild();
      setTimeout(() => child.emit('close', 0), 0);
      return child;
    },
    spawnSync: (...spawnArgs: unknown[]) => {
      const command = String(spawnArgs[0] ?? '');
      const maybeArgs = spawnArgs[1];
      const args = Array.isArray(maybeArgs) ? (maybeArgs as string[]) : [];
      const options = (Array.isArray(maybeArgs) ? spawnArgs[2] : spawnArgs[1]) as
        | Record<string, unknown>
        | undefined;

      return realSpawnSync(command, args, options as Parameters<typeof childProcess.spawnSync>[2]);
    },
    execSync: (...execArgs: unknown[]) =>
      realExecSync(
        execArgs[0] as Parameters<typeof childProcess.execSync>[0],
        execArgs[1] as Parameters<typeof childProcess.execSync>[1]
      ),
  }));
}

function writeConfigWithAutoUpdatePreference(enabled: boolean): void {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-auto-update-pref-'));
  process.env.CCS_HOME = tempHome;
  const ccsDir = path.join(tempHome, '.ccs');
  fs.mkdirSync(ccsDir, { recursive: true });
  const yaml = `version: 8
preferences:
  auto_update: ${enabled ? 'true' : 'false'}
`;
  fs.writeFileSync(path.join(ccsDir, 'config.yaml'), yaml, 'utf8');
}

let execClaude: typeof import('../../../src/utils/shell-executor').execClaude;
let stripClaudeCodeEnv: typeof import('../../../src/utils/shell-executor').stripClaudeCodeEnv;
let HeadlessExecutor: typeof import('../../../src/delegation/headless-executor').HeadlessExecutor;
let SharedManager: typeof import('../../../src/management/shared-manager').default;

beforeAll(async () => {
  registerChildProcessMock();

  const shellExecutor = await import('../../../src/utils/shell-executor');
  execClaude = shellExecutor.execClaude;
  stripClaudeCodeEnv = shellExecutor.stripClaudeCodeEnv;

  const sharedManagerModule = await import('../../../src/management/shared-manager');
  SharedManager = sharedManagerModule.default;

  const headless = await import('../../../src/delegation/headless-executor');
  HeadlessExecutor = headless.HeadlessExecutor;
});

afterAll(() => {
  mock.restore();
});

describe('CLAUDECODE environment stripping', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    process.env.CCS_QUIET = '1';
    originalCcsHome = process.env.CCS_HOME;
    originalCcsClaudePath = process.env.CCS_CLAUDE_PATH;
    originalDisableAutoUpdater = process.env.DISABLE_AUTOUPDATER;
    delete process.env.DISABLE_AUTOUPDATER;
    baselineSigintListeners = process.listeners('SIGINT');
    baselineSigtermListeners = process.listeners('SIGTERM');
    baselineSighupListeners = process.listeners('SIGHUP');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    delete process.env.CLAUDECODE;
    delete process.env.claudecode;
    delete process.env.CCS_QUIET;
    delete process.env.CCS_WEBSEARCH_TRACE;
    if (originalCcsHome !== undefined) process.env.CCS_HOME = originalCcsHome;
    else delete process.env.CCS_HOME;
    if (originalCcsClaudePath !== undefined) process.env.CCS_CLAUDE_PATH = originalCcsClaudePath;
    else delete process.env.CCS_CLAUDE_PATH;
    if (originalDisableAutoUpdater !== undefined) {
      process.env.DISABLE_AUTOUPDATER = originalDisableAutoUpdater;
    } else {
      delete process.env.DISABLE_AUTOUPDATER;
    }

    for (const listener of process.listeners('SIGINT')) {
      if (!baselineSigintListeners.includes(listener)) {
        process.removeListener('SIGINT', listener as (...args: unknown[]) => void);
      }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!baselineSigtermListeners.includes(listener)) {
        process.removeListener('SIGTERM', listener as (...args: unknown[]) => void);
      }
    }
    for (const listener of process.listeners('SIGHUP')) {
      if (!baselineSighupListeners.includes(listener)) {
        process.removeListener('SIGHUP', listener as (...args: unknown[]) => void);
      }
    }
  });

  it('stripClaudeCodeEnv removes CLAUDECODE case-insensitively', () => {
    const input: NodeJS.ProcessEnv = {
      CLAUDECODE: 'upper',
      claudecode: 'lower',
      ClAuDeCoDe: 'mixed',
      PATH: '/usr/bin',
    };

    const result = stripClaudeCodeEnv(input);
    expect(Object.keys(result).map((k) => k.toUpperCase())).not.toContain('CLAUDECODE');
    expect(result.PATH).toBe('/usr/bin');
  });

  it('execClaude strips CLAUDECODE from merged env (including overrides)', () => {
    process.env.CLAUDECODE = 'from-parent';
    process.env.claudecode = 'from-parent-lower';

    execClaude('claude', ['--version'], {
      CCS_PROFILE_TYPE: 'default',
      CLAUDECODE: 'from-override',
      CCS_WEBSEARCH_SKIP: '1',
    });

    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(env).toBeDefined();
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDECODE');
    expect(env.CCS_WEBSEARCH_SKIP).toBe('1');
  });

  it('execClaude keeps behavior when CLAUDECODE is absent', () => {
    execClaude('claude', ['--help'], { CCS_PROFILE_TYPE: 'default' });

    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(env).toBeDefined();
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDECODE');
    expect(env.CCS_PROFILE_TYPE).toBe('default');
  });

  it('execClaude strips CLAUDECODE on Windows shell launch path', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.CLAUDECODE = 'set';

    execClaude('claude.cmd', ['--version'], { CCS_PROFILE_TYPE: 'default' });

    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDECODE');
  });

  it('execClaude sets DISABLE_AUTOUPDATER=1 when preferences.auto_update is false', () => {
    writeConfigWithAutoUpdatePreference(false);
    execClaude('claude', ['--version'], { CCS_PROFILE_TYPE: 'default' });

    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('execClaude does not force DISABLE_AUTOUPDATER when preferences.auto_update is true', () => {
    writeConfigWithAutoUpdatePreference(true);
    execClaude('claude', ['--version'], { CCS_PROFILE_TYPE: 'default' });

    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it('execClaude normalizes shared plugin metadata before default-profile launch', () => {
    const normalizeSpy = spyOn(
      SharedManager.prototype,
      'normalizeSharedPluginMetadataPaths'
    ).mockImplementation(() => {});

    execClaude('claude', ['--help'], { CCS_PROFILE_TYPE: 'default' });

    expect(normalizeSpy).toHaveBeenCalledWith(undefined);
  });

  it('execClaude normalizes shared plugin metadata using CLAUDE_CONFIG_DIR when provided', () => {
    const normalizeSpy = spyOn(
      SharedManager.prototype,
      'normalizeSharedPluginMetadataPaths'
    ).mockImplementation(() => {});
    const instancePath = path.join(os.tmpdir(), 'ccs-shell-executor-instance');

    execClaude('claude', ['--help'], {
      CCS_PROFILE_TYPE: 'settings',
      CLAUDE_CONFIG_DIR: instancePath,
    });

    expect(normalizeSpy).toHaveBeenCalledWith(instancePath);
  });

  it('headless executor spawn path strips CLAUDECODE before spawn', async () => {
    writeConfigWithAutoUpdatePreference(false);
    process.env.CLAUDECODE = 'nested';
    process.env.claudecode = 'nested-lower';

    const result = await (
      HeadlessExecutor as unknown as {
        _spawnAndExecute: (
          claudeCli: string,
          args: string[],
          ctx: {
            cwd: string;
            profile: string;
            timeout: number;
            resumeSession: boolean;
            sessionId: string | null;
            sessionMgr: {
              updateSession: (...args: unknown[]) => void;
              storeSession: (...args: unknown[]) => void;
              cleanupExpired: () => void;
            };
          }
        ) => Promise<unknown>;
      }
    )._spawnAndExecute('claude', ['-p', 'test'], {
      cwd: process.cwd(),
      profile: 'glm',
      timeout: 1000,
      resumeSession: false,
      sessionId: null,
      sessionMgr: {
        updateSession: () => {},
        storeSession: () => {},
        cleanupExpired: () => {},
      },
    });

    expect(result).toBeDefined();
    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(Object.keys(env).map((k) => k.toUpperCase())).not.toContain('CLAUDECODE');
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('headless executor adds third-party WebSearch steering args and env', async () => {
    writeConfigWithAutoUpdatePreference(false);
    const ccsDir = path.join(process.env.CCS_HOME as string, '.ccs');
    fs.writeFileSync(path.join(ccsDir, 'glm.settings.json'), '{}\n', 'utf8');
    const projectDir = path.join(ccsDir, 'project');
    fs.mkdirSync(path.join(projectDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          permissions: {
            deny: ['Bash', 'WebFetch'],
          },
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    process.env.CCS_CLAUDE_PATH = 'claude';

    const result = await HeadlessExecutor.execute('glm', 'latest AI chip news', {
      cwd: projectDir,
      permissionMode: 'default',
      timeout: 1000,
    });

    expect(result.success).toBe(true);
    expect(spawnCalls.length).toBeGreaterThan(0);
    const launch = spawnCalls[0];
    expect(launch.args).toContain('--disallowedTools');
    const disallowedToolsIndex = launch.args.indexOf('--disallowedTools');
    expect(disallowedToolsIndex).toBeGreaterThan(-1);
    expect(launch.args[disallowedToolsIndex + 1]).toBe('Bash,WebFetch,WebSearch');
    expect(launch.args).toContain('--append-system-prompt');
    expect(launch.args.join(' ')).toContain(STEERING_PROMPT_SNIPPET);
    const env = launch.options?.env as NodeJS.ProcessEnv;
    expect(env.CCS_PROFILE_TYPE).toBe('settings');
    expect(env.CCS_WEBSEARCH_ENABLED || env.CCS_WEBSEARCH_SKIP).toBeDefined();
    const claudeUserConfig = JSON.parse(
      fs.readFileSync(path.join(process.env.CCS_HOME as string, '.claude.json'), 'utf8')
    ) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(claudeUserConfig.mcpServers?.['ccs-websearch']).toEqual({
      type: 'stdio',
      command: 'node',
      args: getNodeWebSearchArgs(path.join(ccsDir, 'mcp', 'ccs-websearch-server.cjs')),
      env: getNodeWebSearchEnv(),
    });
  });

  it('headless executor propagates a WebSearch trace launch id when tracing is enabled', async () => {
    writeConfigWithAutoUpdatePreference(false);
    const ccsDir = path.join(process.env.CCS_HOME as string, '.ccs');
    fs.writeFileSync(path.join(ccsDir, 'glm.settings.json'), '{}\n', 'utf8');
    process.env.CCS_CLAUDE_PATH = 'claude';
    process.env.CCS_WEBSEARCH_TRACE = '1';

    const result = await HeadlessExecutor.execute('glm', 'latest AI chip news', {
      permissionMode: 'default',
      timeout: 1000,
    });

    expect(result.success).toBe(true);
    expect(spawnCalls.length).toBeGreaterThan(0);
    const env = spawnCalls[0].options?.env as NodeJS.ProcessEnv;
    expect(env.CCS_WEBSEARCH_TRACE).toBe('1');
    expect(env.CCS_WEBSEARCH_TRACE_LAUNCH_ID).toBeString();
    expect(env.CCS_WEBSEARCH_TRACE_LAUNCHER).toBe('delegation.headless-executor');
  });
});
