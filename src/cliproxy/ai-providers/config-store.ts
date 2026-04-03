import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { configExists, getCliproxyConfigPath, regenerateConfig } from '../config-generator';
import { getProxyTarget } from '../proxy-target-resolver';
import { createManagementClient } from '../management-api-client';
import { rewriteTopLevelYamlSection } from './config-yaml-sections';
import type {
  AiProviderApiKeyEntry,
  AiProviderFamilyId,
  LocalAiProviderConfig,
  OpenAICompatEntry,
} from './types';

type FamilyEntriesMap = {
  'gemini-api-key': AiProviderApiKeyEntry[];
  'codex-api-key': AiProviderApiKeyEntry[];
  'claude-api-key': AiProviderApiKeyEntry[];
  'vertex-api-key': AiProviderApiKeyEntry[];
  'openai-compatibility': OpenAICompatEntry[];
};

export type FamilyEntries<F extends AiProviderFamilyId> = FamilyEntriesMap[F];

type EntryWithOptionalId = {
  id?: string;
};

function createFamilyEntryId(family: AiProviderFamilyId): string {
  return `${family}-${randomUUID()}`;
}

function ensureStableEntryIds<F extends AiProviderFamilyId>(
  family: F,
  entries: FamilyEntries<F>
): { entries: FamilyEntries<F>; changed: boolean } {
  const seenIds = new Set<string>();
  let changed = false;

  const normalizedEntries = entries.map((entry) => {
    const rawId = (entry as EntryWithOptionalId).id;
    const normalizedId = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId.trim() : null;
    const nextId =
      normalizedId && !seenIds.has(normalizedId) ? normalizedId : createFamilyEntryId(family);

    if (normalizedId !== nextId) {
      changed = true;
    }

    seenIds.add(nextId);
    return {
      ...entry,
      id: nextId,
    };
  }) as FamilyEntries<F>;

  return { entries: normalizedEntries, changed };
}

function ensureLocalConfigPath(): string {
  if (!configExists()) {
    regenerateConfig();
  }
  return getCliproxyConfigPath();
}

function readLocalConfig(): LocalAiProviderConfig {
  const configPath = ensureLocalConfigPath();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return (yaml.load(content, { schema: yaml.CORE_SCHEMA }) as LocalAiProviderConfig) || {};
  } catch {
    return {};
  }
}

function writeLocalFamilySection<F extends AiProviderFamilyId>(
  family: F,
  entries: FamilyEntries<F>
): void {
  const configPath = ensureLocalConfigPath();
  const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const sectionYaml =
    entries.length > 0
      ? yaml.dump(
          { [family]: entries },
          {
            indent: 2,
            lineWidth: -1,
            quotingType: "'",
            forceQuotes: false,
          }
        )
      : null;
  const nextContent = rewriteTopLevelYamlSection(content, family, sectionYaml);
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, nextContent, { mode: 0o600 });
  fs.renameSync(tempPath, configPath);
}

export function getAiProvidersSourceSummary() {
  const target = getProxyTarget();
  const managementAuth = target.isRemote
    ? target.managementKey
      ? 'configured'
      : target.authToken
        ? 'fallback'
        : 'missing'
    : 'configured';

  return {
    mode: target.isRemote ? 'remote' : 'local',
    label: target.isRemote ? 'Remote CLIProxy' : 'Local CLIProxy',
    target: `${target.protocol}://${target.host}:${target.port}`,
    managementAuth,
  } as const;
}

export async function readFamilyEntries<F extends AiProviderFamilyId>(
  family: F
): Promise<FamilyEntries<F>> {
  const target = getProxyTarget();

  if (!target.isRemote) {
    const config = readLocalConfig();
    const entries = (Array.isArray(config[family]) ? config[family] : []) as FamilyEntries<F>;
    const normalized = ensureStableEntryIds(family, entries);
    if (normalized.changed) {
      writeLocalFamilySection(family, normalized.entries);
    }
    return normalized.entries;
  }

  const client = createManagementClient({
    host: target.host,
    port: target.port,
    protocol: target.protocol,
    management_key: target.managementKey,
    auth_token: target.authToken,
  });

  const entries = (await client.getSection<FamilyEntries<F>[number]>(family)) as FamilyEntries<F>;
  const normalized = ensureStableEntryIds(
    family,
    Array.isArray(entries) ? entries : ([] as unknown as FamilyEntries<F>)
  );
  if (normalized.changed) {
    await client.putSection<FamilyEntries<F>[number]>(
      family,
      normalized.entries as FamilyEntries<F>[number][]
    );
  }
  return normalized.entries;
}

export async function writeFamilyEntries<F extends AiProviderFamilyId>(
  family: F,
  entries: FamilyEntries<F>
): Promise<void> {
  const normalized = ensureStableEntryIds(family, entries);
  const target = getProxyTarget();

  if (!target.isRemote) {
    writeLocalFamilySection(family, normalized.entries);
    return;
  }

  const client = createManagementClient({
    host: target.host,
    port: target.port,
    protocol: target.protocol,
    management_key: target.managementKey,
    auth_token: target.authToken,
  });

  await client.putSection<FamilyEntries<F>[number]>(
    family,
    normalized.entries as FamilyEntries<F>[number][]
  );
}
