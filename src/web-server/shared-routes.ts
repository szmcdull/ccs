/**
 * Shared Data Routes (Phase 07)
 *
 * API routes for commands, skills, agents from ~/.ccs/shared/
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getCcsDir } from '../utils/config-manager';
import { getClaudeConfigDir } from '../utils/claude-config-path';
import { requireLocalAccessWhenAuthDisabled } from './middleware/auth-middleware';

export const sharedRoutes = Router();

sharedRoutes.use((req: Request, res: Response, next) => {
  if (
    requireLocalAccessWhenAuthDisabled(
      req,
      res,
      'Shared-content endpoints require localhost access when dashboard auth is disabled.'
    )
  ) {
    next();
  }
});

const MAX_DIRECTORY_TRAVERSAL_DEPTH = 10;
const MAX_DESCRIPTION_LENGTH = 140;
const MAX_MARKDOWN_FILE_BYTES = 1024 * 1024; // 1 MiB
const MAX_CONTENT_FILE_BYTES = 2 * 1024 * 1024; // 2 MiB
const SHARED_ITEMS_CACHE_TTL_MS = 1000;

type SharedCollectionType = 'commands' | 'skills' | 'agents';

interface SharedItem {
  name: string;
  description: string;
  path: string;
  type: 'command' | 'skill' | 'agent';
}

interface SharedItemsCacheEntry {
  items: SharedItem[];
  sharedDir: string;
  expiresAt: number;
}

const sharedItemsCache = new Map<SharedCollectionType, SharedItemsCacheEntry>();

/**
 * GET /api/shared/commands
 */
sharedRoutes.get('/commands', (_req: Request, res: Response) => {
  const items = getSharedItems('commands');
  res.json({ items });
});

/**
 * GET /api/shared/skills
 */
sharedRoutes.get('/skills', (_req: Request, res: Response) => {
  const items = getSharedItems('skills');
  res.json({ items });
});

/**
 * GET /api/shared/agents
 */
sharedRoutes.get('/agents', (_req: Request, res: Response) => {
  const items = getSharedItems('agents');
  res.json({ items });
});

/**
 * GET /api/shared/content?type=commands|skills|agents&path=<item-path>
 */
sharedRoutes.get('/content', (req: Request, res: Response) => {
  const typeParam = req.query.type;
  const itemPathParam = req.query.path;

  if (!isSharedCollectionType(typeParam)) {
    res.status(400).json({ error: 'Invalid or missing type parameter' });
    return;
  }
  if (typeof itemPathParam !== 'string' || itemPathParam.trim().length === 0) {
    res.status(400).json({ error: 'Invalid or missing path parameter' });
    return;
  }

  const ccsDir = getCcsDir();
  const sharedDir = path.join(ccsDir, 'shared', typeParam);
  if (!fs.existsSync(sharedDir)) {
    res.status(404).json({ error: 'Shared directory not found' });
    return;
  }

  const sharedDirRoot = safeRealPath(sharedDir) ?? path.resolve(sharedDir);
  const allowedRoots = resolveAllowedRoots(typeParam, ccsDir, sharedDirRoot);
  const contentResult = getSharedItemContent(typeParam, itemPathParam, allowedRoots);

  if (!contentResult) {
    res.status(404).json({ error: 'Shared content not found' });
    return;
  }

  res.json(contentResult);
});

/**
 * GET /api/shared/summary
 */
sharedRoutes.get('/summary', (_req: Request, res: Response) => {
  const commands = getSharedItems('commands').length;
  const skills = getSharedItems('skills').length;
  const agents = getSharedItems('agents').length;

  res.json({
    commands,
    skills,
    agents,
    total: commands + skills + agents,
    symlinkStatus: checkSymlinkStatus(),
  });
});

function isSharedCollectionType(value: unknown): value is SharedCollectionType {
  return value === 'commands' || value === 'skills' || value === 'agents';
}

function resolveAllowedRoots(
  type: SharedCollectionType,
  ccsDir: string,
  sharedDirRoot: string
): Set<string> {
  if (type === 'commands') {
    return new Set<string>([sharedDirRoot]);
  }

  return new Set<string>([
    sharedDirRoot,
    ...[
      path.join(getClaudeConfigDir(), type),
      path.join(ccsDir, '.claude', type),
      path.join(ccsDir, 'shared', type),
    ]
      .map((dirPath) => safeRealPath(dirPath))
      .filter((dirPath): dirPath is string => typeof dirPath === 'string'),
  ]);
}

function getSharedItems(type: SharedCollectionType): SharedItem[] {
  const ccsDir = getCcsDir();
  const sharedDir = path.join(ccsDir, 'shared', type);
  const now = Date.now();

  if (!fs.existsSync(sharedDir)) {
    sharedItemsCache.delete(type);
    return [];
  }

  const cached = sharedItemsCache.get(type);
  if (cached && cached.sharedDir === sharedDir && cached.expiresAt > now) {
    return cached.items;
  }

  const items: SharedItem[] = [];
  const sharedDirRoot = safeRealPath(sharedDir) ?? path.resolve(sharedDir);
  const allowedRoots = resolveAllowedRoots(type, ccsDir, sharedDirRoot);

  if (type === 'commands') {
    const commandItems = getCommandItems(sharedDir, allowedRoots);
    sharedItemsCache.set(type, {
      items: commandItems,
      sharedDir,
      expiresAt: now + SHARED_ITEMS_CACHE_TTL_MS,
    });
    return commandItems;
  }

  try {
    const entries = fs.readdirSync(sharedDir, { withFileTypes: true });

    for (const entry of entries) {
      try {
        const entryPath = path.join(sharedDir, entry.name);
        const resolvedEntryPath = safeRealPath(entryPath);
        if (!resolvedEntryPath || !isPathWithinAny(resolvedEntryPath, allowedRoots)) {
          continue;
        }

        const stats = fs.statSync(resolvedEntryPath);
        const item = getSkillOrAgentItem(
          type,
          entry,
          entryPath,
          resolvedEntryPath,
          allowedRoots,
          stats
        );
        if (!item) {
          continue;
        }

        items.push(item);
      } catch {
        // Fail soft per entry so one bad item does not hide valid results.
      }
    }
  } catch {
    // Directory read failed
  }

  const sortedItems = items.sort((a, b) => a.name.localeCompare(b.name));
  sharedItemsCache.set(type, {
    items: sortedItems,
    sharedDir,
    expiresAt: now + SHARED_ITEMS_CACHE_TTL_MS,
  });
  return sortedItems;
}

function getCommandItems(sharedDir: string, allowedRoots: Set<string>): SharedItem[] {
  const markdownFiles = collectMarkdownFiles(sharedDir, allowedRoots);
  const items: SharedItem[] = [];

  for (const markdownFile of markdownFiles) {
    const description = readMarkdownDescription(markdownFile.resolvedPath, allowedRoots);
    if (!description) {
      continue;
    }

    const relativePath = path.relative(sharedDir, markdownFile.displayPath);
    const normalizedName = relativePath.split(path.sep).join('/').replace(/\.md$/i, '');
    if (!normalizedName) {
      continue;
    }

    items.push({
      name: normalizedName,
      description,
      path: markdownFile.displayPath,
      type: 'command',
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function getSkillOrAgentItem(
  type: 'skills' | 'agents',
  entry: fs.Dirent,
  entryPath: string,
  resolvedEntryPath: string,
  allowedRoots: Set<string>,
  stats: fs.Stats
): SharedItem | null {
  if (type === 'skills') {
    if (!stats.isDirectory()) {
      return null;
    }

    const description = readMarkdownDescription(
      path.join(resolvedEntryPath, 'SKILL.md'),
      allowedRoots
    );
    if (!description) {
      return null;
    }

    return {
      name: entry.name,
      description,
      path: entryPath,
      type: 'skill',
    };
  }

  if (stats.isDirectory()) {
    const description = readFirstMarkdownDescription(
      [
        path.join(resolvedEntryPath, 'prompt.md'),
        path.join(resolvedEntryPath, 'AGENT.md'),
        path.join(resolvedEntryPath, 'agent.md'),
      ],
      allowedRoots
    );
    if (!description) {
      return null;
    }

    return {
      name: entry.name,
      description,
      path: entryPath,
      type: 'agent',
    };
  }

  if (!stats.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
    return null;
  }

  const description = readMarkdownDescription(resolvedEntryPath, allowedRoots);
  if (!description) {
    return null;
  }

  return {
    name: entry.name.replace(/\.md$/i, ''),
    description,
    path: entryPath,
    type: 'agent',
  };
}

interface MarkdownFileEntry {
  displayPath: string;
  resolvedPath: string;
}

function collectMarkdownFiles(sharedDir: string, allowedRoots: Set<string>): MarkdownFileEntry[] {
  const directoriesToVisit: Array<{ path: string; depth: number }> = [
    { path: sharedDir, depth: 0 },
  ];
  const visitedDirectories = new Set<string>();
  const markdownFiles: MarkdownFileEntry[] = [];

  while (directoriesToVisit.length > 0) {
    const current = directoriesToVisit.pop();
    if (!current) {
      continue;
    }

    const currentDir = current.path;
    const resolvedCurrentDir = safeRealPath(currentDir);
    if (!resolvedCurrentDir || !isPathWithinAny(resolvedCurrentDir, allowedRoots)) {
      continue;
    }

    const normalizedDirPath = normalizeForPathComparison(resolvedCurrentDir);
    if (visitedDirectories.has(normalizedDirPath)) {
      continue;
    }
    visitedDirectories.add(normalizedDirPath);

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const resolvedEntryPath = safeRealPath(entryPath);
      if (!resolvedEntryPath || !isPathWithinAny(resolvedEntryPath, allowedRoots)) {
        continue;
      }

      let stats: fs.Stats;
      try {
        stats = fs.statSync(resolvedEntryPath);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        if (current.depth < MAX_DIRECTORY_TRAVERSAL_DEPTH) {
          directoriesToVisit.push({ path: entryPath, depth: current.depth + 1 });
        }
        continue;
      }

      if (stats.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        markdownFiles.push({
          displayPath: entryPath,
          resolvedPath: resolvedEntryPath,
        });
      }
    }
  }

  return markdownFiles;
}

function extractDescription(content: string): string {
  const frontmatterDescription = extractFrontmatterDescription(content);
  if (frontmatterDescription) {
    return trimDescription(frontmatterDescription);
  }

  // Extract first non-empty, non-heading line from the markdown body.
  const lines = stripFrontmatter(content).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (isDescriptionBodyLine(trimmed)) {
      return trimDescription(trimmed);
    }
  }

  return 'No description';
}

function isDescriptionBodyLine(line: string): boolean {
  if (!line) {
    return false;
  }

  if (line === '---' || line === '...') {
    return false;
  }

  return !line.startsWith('#') && !line.startsWith('<!--');
}

function extractFrontmatterDescription(content: string): string | null {
  const frontmatterMatch = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
  if (!frontmatterMatch) {
    return null;
  }

  try {
    const parsed = yaml.load(frontmatterMatch[1], { schema: yaml.CORE_SCHEMA }) as Record<
      string,
      unknown
    > | null;
    const description = parsed?.description;
    if (typeof description !== 'string') {
      return null;
    }

    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '');
}

function trimDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_LENGTH) {
    return description;
  }

  return `${description.slice(0, MAX_DESCRIPTION_LENGTH - 3).trimEnd()}...`;
}

function readFirstMarkdownDescription(
  markdownPaths: string[],
  allowedRoots: Set<string>
): string | null {
  for (const markdownPath of markdownPaths) {
    const description = readMarkdownDescription(markdownPath, allowedRoots);
    if (description) {
      return description;
    }
  }

  return null;
}

function readMarkdownDescription(markdownPath: string, allowedRoots: Set<string>): string | null {
  try {
    const resolvedMarkdownPath = safeRealPath(markdownPath);
    if (!resolvedMarkdownPath || !isPathWithinAny(resolvedMarkdownPath, allowedRoots)) {
      return null;
    }

    const stats = fs.statSync(resolvedMarkdownPath);
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > MAX_MARKDOWN_FILE_BYTES) {
      return null;
    }
    const content = fs.readFileSync(resolvedMarkdownPath, 'utf8');
    return extractDescription(content);
  } catch {
    return null;
  }
}

function readMarkdownContent(markdownPath: string, allowedRoots: Set<string>): string | null {
  try {
    const resolvedMarkdownPath = safeRealPath(markdownPath);
    if (!resolvedMarkdownPath || !isPathWithinAny(resolvedMarkdownPath, allowedRoots)) {
      return null;
    }

    const stats = fs.statSync(resolvedMarkdownPath);
    if (!stats.isFile()) {
      return null;
    }
    if (stats.size > MAX_CONTENT_FILE_BYTES) {
      return null;
    }

    return fs.readFileSync(resolvedMarkdownPath, 'utf8');
  } catch {
    return null;
  }
}

function resolveReadableMarkdownPath(
  markdownPaths: string[],
  allowedRoots: Set<string>
): string | null {
  for (const markdownPath of markdownPaths) {
    const resolvedMarkdownPath = safeRealPath(markdownPath);
    if (!resolvedMarkdownPath || !isPathWithinAny(resolvedMarkdownPath, allowedRoots)) {
      continue;
    }

    try {
      const stats = fs.statSync(resolvedMarkdownPath);
      if (!stats.isFile() || stats.size > MAX_CONTENT_FILE_BYTES) {
        continue;
      }
      return resolvedMarkdownPath;
    } catch {
      continue;
    }
  }

  return null;
}

function getSharedItemContent(
  type: SharedCollectionType,
  itemPath: string,
  allowedRoots: Set<string>
): { content: string; contentPath: string } | null {
  const resolvedItemPath = safeRealPath(itemPath);
  if (!resolvedItemPath || !isPathWithinAny(resolvedItemPath, allowedRoots)) {
    return null;
  }

  let itemStats: fs.Stats;
  try {
    itemStats = fs.statSync(resolvedItemPath);
  } catch {
    return null;
  }

  let markdownPath: string | null = null;
  if (type === 'commands') {
    if (!itemStats.isFile() || !itemPath.toLowerCase().endsWith('.md')) {
      return null;
    }
    markdownPath = resolvedItemPath;
  } else if (type === 'skills') {
    if (!itemStats.isDirectory()) {
      return null;
    }
    markdownPath = resolveReadableMarkdownPath(
      [path.join(resolvedItemPath, 'SKILL.md')],
      allowedRoots
    );
  } else {
    if (itemStats.isDirectory()) {
      markdownPath = resolveReadableMarkdownPath(
        [
          path.join(resolvedItemPath, 'prompt.md'),
          path.join(resolvedItemPath, 'AGENT.md'),
          path.join(resolvedItemPath, 'agent.md'),
        ],
        allowedRoots
      );
    } else if (itemStats.isFile() && itemPath.toLowerCase().endsWith('.md')) {
      markdownPath = resolvedItemPath;
    }
  }

  if (!markdownPath) {
    return null;
  }

  const content = readMarkdownContent(markdownPath, allowedRoots);
  if (!content) {
    return null;
  }

  return {
    content,
    contentPath: markdownPath,
  };
}

function safeRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function isPathWithin(candidatePath: string, basePath: string): boolean {
  const normalizedCandidate = normalizeForPathComparison(candidatePath);
  const normalizedBase = normalizeForPathComparison(basePath);
  const relative = path.relative(normalizedBase, normalizedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPathWithinAny(candidatePath: string, basePaths: Set<string>): boolean {
  for (const basePath of basePaths) {
    if (isPathWithin(candidatePath, basePath)) {
      return true;
    }
  }
  return false;
}

function normalizeForPathComparison(targetPath: string): string {
  const normalized = path.resolve(targetPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function checkSymlinkStatus(): { valid: boolean; message: string } {
  const ccsDir = getCcsDir();
  const sharedDir = path.join(ccsDir, 'shared');

  if (!fs.existsSync(sharedDir)) {
    return { valid: false, message: 'Shared directory not found' };
  }

  // Check all three symlinks: commands, skills, agents
  const linkTypes = ['commands', 'skills', 'agents'];
  let validLinks = 0;

  for (const linkType of linkTypes) {
    const linkPath = path.join(sharedDir, linkType);

    try {
      if (fs.existsSync(linkPath)) {
        const stats = fs.lstatSync(linkPath);
        if (stats.isSymbolicLink()) {
          const target = fs.readlinkSync(linkPath);
          // Check if it points to Claude config dir.
          const expectedTarget = path.join(getClaudeConfigDir(), linkType);
          if (path.resolve(path.dirname(linkPath), target) === path.resolve(expectedTarget)) {
            validLinks++;
          }
        }
      }
    } catch {
      // Not a symlink or read error
    }
  }

  if (validLinks === linkTypes.length) {
    return { valid: true, message: 'Symlinks active' };
  } else if (validLinks > 0) {
    return {
      valid: false,
      message: `Symlinks partially configured (${validLinks}/${linkTypes.length})`,
    };
  }

  return { valid: false, message: 'Symlinks not configured' };
}
