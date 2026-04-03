import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packetBuilder = await import('../../../../scripts/github/build-ai-review-packet.mjs');

function withTempDir(prefix: string, run: (tempDir: string) => void) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('build-ai-review-packet', () => {
  test('adds stable line numbers to packet content blocks', () => {
    expect(packetBuilder.addLineNumbers('first\nsecond')).toBe('   1 | first\n   2 | second');
  });

  test('builds a packet with current and base snapshots for selected files', () => {
    withTempDir('ai-review-packet-', (tempDir) => {
      const rootDir = path.join(tempDir, 'repo');
      const baseDir = path.join(tempDir, '.ccs-ai-review-base');
      fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(rootDir, 'src/example.ts'), 'export const value = 2;\nconsole.log(value);\n');
      fs.writeFileSync(path.join(baseDir, 'src/example.ts'), 'export const value = 1;\n');

      const packet = packetBuilder.buildReviewPacket({
        scopeMarkdown: '# AI Review Scope\n\n- Selected files: 1 of 1 reviewable files',
        files: ['src/example.ts'],
        rootDir,
        baseDir,
        maxChars: 20000,
        perFileMaxLines: 40,
        perFileMaxChars: 4000,
      }).packet;

      expect(packet).toContain('# AI Review Packet');
      expect(packet).toContain('## File: `src/example.ts`');
      expect(packet).toContain('### Current file content');
      expect(packet).toContain('   1 | export const value = 2;');
      expect(packet).toContain('### Base snapshot content');
      expect(packet).toContain('   1 | export const value = 1;');
      expect(packet).toContain('- Selected files in packet: 1 of 1');
    });
  });

  test('omits file snapshots when the global packet budget is exceeded', () => {
    withTempDir('ai-review-packet-', (tempDir) => {
      const rootDir = path.join(tempDir, 'repo');
      const baseDir = path.join(tempDir, '.ccs-ai-review-base');
      fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });

      fs.writeFileSync(path.join(rootDir, 'src/one.ts'), 'export const one = 1;\n'.repeat(30));
      fs.writeFileSync(path.join(rootDir, 'src/two.ts'), 'export const two = 2;\n'.repeat(30));
      fs.writeFileSync(path.join(baseDir, 'src/one.ts'), 'export const one = 0;\n');
      fs.writeFileSync(path.join(baseDir, 'src/two.ts'), 'export const two = 0;\n');

      const packet = packetBuilder.buildReviewPacket({
        scopeMarkdown: '# AI Review Scope\n\n' + '- review scope metadata\n'.repeat(60),
        files: ['src/one.ts', 'src/two.ts'],
        rootDir,
        baseDir,
        maxChars: 1500,
        perFileMaxLines: 120,
        perFileMaxChars: 8000,
      }).packet;

      expect(packet).not.toContain('## File: `src/two.ts`');
      expect(packet).toContain('Additional selected files omitted from packet due to the global context budget: 2');
    });
  });

  test('keeps the full packet within the configured maxChars budget', () => {
    withTempDir('ai-review-packet-', (tempDir) => {
      const rootDir = path.join(tempDir, 'repo');
      const baseDir = path.join(tempDir, '.ccs-ai-review-base');
      fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(baseDir, 'src'), { recursive: true });

      fs.writeFileSync(path.join(rootDir, 'src/huge.ts'), 'export const huge = 1;\n'.repeat(80));
      fs.writeFileSync(path.join(baseDir, 'src/huge.ts'), 'export const base = 0;\n'.repeat(80));

      const result = packetBuilder.buildReviewPacket({
        scopeMarkdown: '# AI Review Scope\n\n' + '- selected file\n'.repeat(200),
        files: ['src/huge.ts'],
        rootDir,
        baseDir,
        maxChars: 1000,
        perFileMaxLines: 200,
        perFileMaxChars: 12000,
      });

      expect(result.packet.length).toBeLessThanOrEqual(1000);
      expect(result.totalSelectedFiles).toBe(1);
      expect(result.includedFilePaths).toEqual([]);
      expect(result.packet).toContain('Scope metadata was truncated to preserve packet budget for file contents.');
    });
  });
});
