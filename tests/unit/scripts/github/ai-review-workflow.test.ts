import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

function loadWorkflow() {
  const workflowPath = path.resolve(import.meta.dir, '../../../../.github/workflows/ai-review.yml');
  return fs.readFileSync(workflowPath, 'utf8');
}

describe('ai-review workflow', () => {
  test('uses the claude-code-action reviewer path with glm-5-turbo and PR-sha comment markers', () => {
    const workflow = loadWorkflow();

    expect(workflow).toContain('REVIEW_MODEL: glm-5-turbo');
    expect(workflow).toContain('ANTHROPIC_MODEL: glm-5-turbo');
    expect(workflow).toContain('uses: anthropics/claude-code-action@v1');
    expect(workflow).toContain('--model ${{ env.REVIEW_MODEL }}');
    expect(workflow).toContain('--max-turns 40');
    expect(workflow).toContain('--json-schema');
    expect(workflow).toContain('normalize-ai-review-output.mjs');
    expect(workflow).not.toContain('build-ai-review-packet.mjs');
    expect(workflow).not.toContain('run-ai-review-direct.mjs');
    expect(workflow).toContain('pr:${{ needs.prepare.outputs.pr_number }}');
    expect(workflow).toContain('sha:${{ needs.prepare.outputs.head_sha }}');
    expect(workflow).not.toContain('run:${{ github.run_id }}');
  });
});
