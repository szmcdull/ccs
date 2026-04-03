/**
 * Local Config Sync
 *
 * Syncs CCS API profiles to the local CLIProxy config.yaml.
 * Uses section-based replacement to preserve comments and formatting.
 */

import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { getCliproxyConfigPath } from '../config-generator';
import { generateSyncPayload } from './profile-mapper';
import type { ClaudeKey } from '../management-api-types';

/**
 * Sync profiles to local CLIProxy config.yaml.
 * Replaces only the claude-api-key section, preserving all other content.
 *
 * @returns Object with success status and synced count
 */
export function syncToLocalConfig(): {
  success: boolean;
  syncedCount: number;
  configPath: string;
  error?: string;
} {
  const configPath = getCliproxyConfigPath();

  try {
    // Generate payload from CCS profiles
    const payload = generateSyncPayload();

    if (payload.length === 0) {
      return {
        success: true,
        syncedCount: 0,
        configPath,
      };
    }

    // Read existing config
    if (!fs.existsSync(configPath)) {
      return {
        success: false,
        syncedCount: 0,
        configPath,
        error: 'CLIProxy config not found. Run ccs doctor to generate.',
      };
    }

    let configContent: string;
    try {
      configContent = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          success: false,
          syncedCount: 0,
          configPath,
          error: 'CLIProxy config deleted during sync. Run ccs doctor to regenerate.',
        };
      }
      throw error;
    }

    // Transform payload to config format
    const claudeApiKeys = payload.map(transformToConfigFormat);

    // Generate YAML for the claude-api-key section only
    const newSection = yaml.dump(
      { 'claude-api-key': claudeApiKeys },
      {
        indent: 2,
        lineWidth: -1,
        quotingType: "'",
        forceQuotes: false,
      }
    );

    // Replace section in original content (preserves comments/formatting)
    const newContent = replaceSectionInYaml(configContent, 'claude-api-key', newSection);

    // Atomic write with cleanup on failure
    const tempPath = configPath + '.tmp';
    try {
      fs.writeFileSync(tempPath, newContent, { mode: 0o600 });
      fs.renameSync(tempPath, configPath);
    } catch (writeError) {
      // Clean up temp file if it exists
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw writeError;
    }

    return {
      success: true,
      syncedCount: payload.length,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      syncedCount: 0,
      configPath,
      error: (error as Error).message,
    };
  }
}

/**
 * Replace a top-level section in YAML content while preserving rest of file.
 * Finds the section by key name and replaces it (including nested content).
 */
function replaceSectionInYaml(content: string, sectionKey: string, newSection: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inSection = false;
  let sectionFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Check if this is the start of our target section
    if (trimmed.startsWith(`${sectionKey}:`)) {
      inSection = true;
      sectionFound = true;

      // Insert new section here
      result.push(newSection.trimEnd());
      continue;
    }

    // If we're in the section, skip lines until we hit another top-level key
    if (inSection) {
      // Top-level key: starts at column 0, valid YAML key format (word chars + hyphens)
      // Must match pattern like "key:", "my-key:", "key_name:" but not comments or strings
      const isTopLevelKey =
        line.length > 0 &&
        !line.startsWith(' ') &&
        !line.startsWith('\t') &&
        !line.startsWith('#') &&
        /^[a-zA-Z_][a-zA-Z0-9_-]*\s*:/.test(line);

      if (isTopLevelKey) {
        // We've exited the section, resume normal processing
        inSection = false;
        result.push(line);
      }
      // Otherwise skip this line (part of old section)
      continue;
    }

    result.push(line);
  }

  // If section wasn't found, append it at the end
  if (!sectionFound) {
    result.push('');
    result.push(newSection.trimEnd());
  }

  return result.join('\n');
}

/**
 * Transform ClaudeKey to config.yaml format.
 * The config format uses slightly different field names.
 */
function transformToConfigFormat(key: ClaudeKey): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    'api-key': key['api-key'],
  };

  if (key['base-url']) {
    entry['base-url'] = key['base-url'];
  }

  // Add empty proxy-url (required by CLIProxyAPI)
  entry['proxy-url'] = '';

  // Use model name directly (no alias mapping)
  if (key.models && key.models.length > 0) {
    entry.models = key.models.map((m) => ({
      name: m.name,
      alias: '',
    }));
  }

  // Note: prefix is not used in local config - it's for remote routing only

  return entry;
}

/**
 * Get local sync status.
 */
export function getLocalSyncStatus(): {
  configExists: boolean;
  configPath: string;
  currentKeyCount: number;
  syncableProfileCount: number;
} {
  const configPath = getCliproxyConfigPath();
  let currentKeyCount = 0;

  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = yaml.load(content, { schema: yaml.CORE_SCHEMA }) as Record<
        string,
        unknown
      > | null;
      if (config && typeof config === 'object') {
        const keys = config['claude-api-key'];
        if (Array.isArray(keys)) {
          currentKeyCount = keys.length;
        }
      }
    } catch {
      // Ignore parse errors
    }
  }

  const payload = generateSyncPayload();

  return {
    configExists: fs.existsSync(configPath),
    configPath,
    currentKeyCount,
    syncableProfileCount: payload.length,
  };
}
