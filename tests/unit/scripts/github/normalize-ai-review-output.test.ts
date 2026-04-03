import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const reviewOutput = await import('../../../../scripts/github/normalize-ai-review-output.mjs');

function withTempDir(prefix: string, run: (tempDir: string) => void) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    run(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('normalize-ai-review-output', () => {
  test('renders validated structured output into the legacy long-form markdown layout', () => {
    const validation = reviewOutput.normalizeStructuredOutput(
      JSON.stringify({
        summary: 'The PR is mostly correct, but one blocking regression remains.',
        findings: [
          {
            severity: 'high',
            title: 'Ambiguous account lookup drops valid matches',
            file: 'src/cliproxy/accounts/query.ts',
            line: 61,
            what: 'Exact email matches can return null when duplicate accounts exist.',
            why: 'That breaks normal selection flows for users with multiple Codex sessions.',
            fix: 'Match by stable account identity first and keep ambiguous email lookups out of exact-match paths.',
          },
        ],
        securityChecklist: [
          {
            check: 'Injection safety',
            status: 'pass',
            notes: 'No user-controlled input reaches a shell, SQL, or HTML boundary in this diff.',
          },
        ],
        ccsCompliance: [
          {
            rule: 'No emojis in CLI',
            status: 'na',
            notes: 'This change affects GitHub PR comments only, not CLI stdout.',
          },
        ],
        informational: ['The renderer still escapes markdown before publishing comment content.'],
        strengths: [
          'The formatter owns the output shape instead of trusting the model to author markdown.',
        ],
        overallAssessment: 'changes_requested',
        overallRationale: 'The blocking lookup regression should be fixed before merge.',
      })
    );

    expect(validation.ok).toBe(true);
    const markdown = reviewOutput.renderStructuredReview(validation.value, {
      model: 'glm-5-turbo',
    });

    expect(markdown).toContain('### 📋 Summary');
    expect(markdown).toContain('### 🔍 Findings');
    expect(markdown).toContain('### 🔴 High');
    expect(markdown).toContain(
      '**`src/cliproxy/accounts/query.ts:61` — Ambiguous account lookup drops valid matches**'
    );
    expect(markdown).toContain(
      'Problem: Exact email matches can return null when duplicate accounts exist.'
    );
    expect(markdown).toContain(
      'Why it matters: That breaks normal selection flows for users with multiple Codex sessions.'
    );
    expect(markdown).toContain(
      'Suggested fix: Match by stable account identity first and keep ambiguous email lookups out of exact-match paths.'
    );
    expect(markdown).toContain('### 🔒 Security Checklist');
    expect(markdown).toContain(
      '| Injection safety | ✅ | No user-controlled input reaches a shell, SQL, or HTML boundary in this diff. |'
    );
    expect(markdown).toContain('### 📊 CCS Compliance');
    expect(markdown).toContain(
      '| No emojis in CLI | N/A | This change affects GitHub PR comments only, not CLI stdout. |'
    );
    expect(markdown).toContain('### 💡 Informational');
    expect(markdown).toContain("### ✅ What's Done Well");
    expect(markdown).toContain('### 🎯 Overall Assessment');
    expect(markdown).toContain('**❌ CHANGES REQUESTED**');
    expect(markdown).toContain('> 🤖 Reviewed by `glm-5-turbo`');
  });

  test('keeps summary-first layout while still rendering review context metadata', () => {
    const validation = reviewOutput.normalizeStructuredOutput(
      JSON.stringify({
        summary: 'The large diff review stayed focused on the riskiest hotspots.',
        findings: [],
        securityChecklist: [
          {
            check: 'Workflow safety',
            status: 'pass',
            notes: 'The review stayed read-only and did not invoke write-capable tools.',
          },
        ],
        ccsCompliance: [
          {
            rule: 'Plain structured output',
            status: 'pass',
            notes: 'The assistant returned data fields only, without layout markdown.',
          },
        ],
        informational: [],
        strengths: [],
        overallAssessment: 'approved_with_notes',
        overallRationale: 'The review stayed bounded and did not surface blocking regressions.',
      })
    );

    expect(validation.ok).toBe(true);
    const markdown = reviewOutput.renderStructuredReview(validation.value, {
      model: 'glm-5-turbo',
      rendering: {
        mode: 'triage',
        selectedFiles: 8,
        reviewableFiles: 34,
        selectedChanges: 620,
        reviewableChanges: 2140,
        packetIncludedFiles: 6,
        packetTotalFiles: 8,
        packetOmittedFiles: 2,
        maxTurns: 6,
        timeoutMinutes: 5,
      },
    });

    expect(markdown).toContain('### 📋 Summary');
    expect(markdown).toContain(
      '> 🧭 `triage` • 8/34 files • 620/2140 lines • packet 6/8 • 6 turns / 5 minutes'
    );
    expect(markdown).toContain('### 🎯 Overall Assessment');
  });

  test('renders finding snippets as renderer-owned fenced code blocks', () => {
    const validation = reviewOutput.normalizeStructuredOutput(
      JSON.stringify({
        summary: 'One non-blocking follow-up remains.',
        findings: [
          {
            severity: 'medium',
            title: 'Fallback branch still writes the stale marker file',
            file: '.github/workflows/ai-review.yml',
            line: 181,
            what: 'One branch still writes the old marker file path.',
            why: 'That can leave duplicate bot comments on reruns for the same PR SHA.',
            fix: 'Keep the rerun marker keyed to PR plus head SHA in every publish branch.',
            snippets: [
              {
                label: 'Current publish branch',
                language: 'bash',
                code: 'marker_file=\"$RUNNER_TEMP/.ai-review-marker\"\nprintf \"%s\\n\" \"$REVIEW_MARKER\" > \"$marker_file\"',
              },
            ],
          },
        ],
        securityChecklist: [{ check: 'Workflow safety', status: 'pass', notes: 'Covered.' }],
        ccsCompliance: [{ rule: 'Renderer-owned markdown', status: 'pass', notes: 'Covered.' }],
        informational: [],
        strengths: [],
        overallAssessment: 'approved_with_notes',
        overallRationale: 'This is a deterministic formatting-only follow-up.',
      })
    );

    expect(validation.ok).toBe(true);
    const markdown = reviewOutput.renderStructuredReview(validation.value, {
      model: 'glm-5-turbo',
    });

    expect(markdown).toContain('Evidence: Current publish branch');
    expect(markdown).toContain('```bash');
    expect(markdown).toContain('marker_file="$RUNNER_TEMP/.ai-review-marker"');
  });

  test('writes a safe incomplete comment instead of leaking raw assistant text', () => {
    withTempDir('ai-review-', (tempDir) => {
      const executionFile = path.join(tempDir, 'claude-execution-output.json');
      const outputFile = path.join(tempDir, 'pr_review.md');

      fs.writeFileSync(
        executionFile,
        JSON.stringify([
          { type: 'system', subtype: 'init', tools: ['Bash', 'Edit', 'Read'] },
          {
            type: 'result',
            subtype: 'success',
            num_turns: 25,
            result: 'Now let me verify the findings before I finalize the review...',
          },
        ])
      );

      const result = reviewOutput.writeReviewFromEnv({
        AI_REVIEW_EXECUTION_FILE: executionFile,
        AI_REVIEW_MODEL: 'glm-5-turbo',
        AI_REVIEW_OUTPUT_FILE: outputFile,
        AI_REVIEW_RUN_URL: 'https://github.com/kaitranntt/ccs/actions/runs/23758377592',
        AI_REVIEW_STRUCTURED_OUTPUT: '',
      });

      expect(result.usedFallback).toBe(true);

      const markdown = fs.readFileSync(outputFile, 'utf8');
      expect(markdown).toContain('### ⚠️ AI Review Incomplete');
      expect(markdown).toContain('Runtime tools: `Bash`, `Edit`, `Read`');
      expect(markdown).toContain('Turns used: 25');
      expect(markdown).not.toContain('Now let me verify the findings');
    });
  });

  test('rejects ad hoc layout markup inside structured fields', () => {
    const validation = reviewOutput.normalizeStructuredOutput(
      JSON.stringify({
        summary: '# PR #860 Review',
        findings: [],
        securityChecklist: [{ check: 'Injection safety', status: 'pass', notes: 'Covered.' }],
        ccsCompliance: [{ rule: 'ASCII-only CLI output', status: 'pass', notes: 'Unaffected.' }],
        informational: [],
        strengths: [],
        overallAssessment: 'approved_with_notes',
        overallRationale: 'The review is otherwise valid.',
      })
    );

    expect(validation.ok).toBe(false);
    expect(validation.reason).toContain('summary contains');
  });
});
