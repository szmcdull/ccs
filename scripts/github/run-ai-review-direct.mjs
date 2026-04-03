import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStructuredOutput,
  renderIncompleteReview,
  renderStructuredReview,
} from './normalize-ai-review-output.mjs';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readTextFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readSelectedFiles(filePath) {
  return readTextFile(filePath)
    .split('\n')
    .map((line) => cleanText(line))
    .filter(Boolean);
}

function stripCodeFence(value) {
  const text = cleanText(value);
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/u);
  return fenceMatch ? cleanText(fenceMatch[1]) : text;
}

export function extractJsonCandidate(value) {
  const text = stripCodeFence(value);
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return text.slice(firstBrace, lastBrace + 1);
  }
  return text;
}

function collectMessageText(responseJson) {
  const content = Array.isArray(responseJson?.content) ? responseJson.content : [];
  return content
    .filter((block) => block?.type === 'text' && typeof block?.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

async function postReviewRequest({ apiUrl, apiKey, model, system, prompt, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'anthropic-version': '2023-06-01',
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        model,
        max_tokens: 6000,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`review api returned ${response.status}: ${errorText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function buildSystemPrompt(reviewPrompt) {
  return `${reviewPrompt}

## Critical Response Contract

Return JSON only. Do not wrap it in markdown fences.
Return a single object with these keys only:
- summary
- findings
- securityChecklist
- ccsCompliance
- informational
- strengths
- overallAssessment
- overallRationale

Each finding may optionally include:
- snippets: an array of up to 2 objects with required code plus optional label and language

If snippets are present:
- keep code literal only, without markdown fences
- keep each snippet under 20 lines
- use snippets only for short evidence that materially clarifies the finding

Use empty arrays rather than inventing low-value feedback.
Every finding must be confirmed by the review packet.`;
}

function buildPrimaryPrompt({ meta, packet }) {
  return `REPO: ${meta.repository}
PR NUMBER: ${meta.prNumber}
PR BASE REF: ${meta.baseRef}
PR HEAD REF: ${meta.headRef}
PR HEAD SHA: ${meta.headSha}
CONTRIBUTOR: @${meta.authorLogin}
AUTHOR ASSOCIATION: ${meta.authorAssociation}
REVIEW MODE: ${meta.reviewMode}
PR SIZE CLASS: ${meta.sizeClass}
CHANGED FILES: ${meta.changedFiles}
ADDITIONS: ${meta.additions}
DELETIONS: ${meta.deletions}
TOTAL CHURN: ${meta.totalChurn}

Review the generated packet below and return the final JSON review object.

${packet}`;
}

function buildRepairPrompt({ validationReason, previousCandidate }) {
  return `Your previous response did not validate: ${validationReason}.

Return corrected JSON only. Keep only confirmed findings. Do not add markdown fences.

Previous candidate:
${previousCandidate}`;
}

export function resolveAttemptWindow({
  timeoutMinutes,
  configuredTimeoutMs,
  requestBufferMs = 45000,
  minAttemptMs = 20000,
  startedAt = Date.now(),
  now = Date.now(),
}) {
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes <= 0) {
    return {
      canAttempt: true,
      timeoutMs: configuredTimeoutMs,
      deadline: null,
      remainingMs: null,
    };
  }

  const stepBudgetMs = timeoutMinutes * 60 * 1000;
  const bufferMs = Math.min(Math.max(requestBufferMs, 5000), Math.max(stepBudgetMs - 5000, 5000));
  const deadline = startedAt + Math.max(stepBudgetMs - bufferMs, minAttemptMs);
  const remainingMs = deadline - now;

  if (remainingMs < minAttemptMs) {
    return {
      canAttempt: false,
      timeoutMs: null,
      deadline,
      remainingMs,
    };
  }

  return {
    canAttempt: true,
    timeoutMs: Math.min(configuredTimeoutMs, remainingMs),
    deadline,
    remainingMs,
  };
}

export function resolveCoveredSelectedFiles({
  selectedFiles,
  packetIncludedFiles,
  includedManifestFiles,
}) {
  if (includedManifestFiles.length > 0) {
    return includedManifestFiles;
  }
  if (!Number.isInteger(packetIncludedFiles) || packetIncludedFiles <= 0) {
    return [];
  }
  if (packetIncludedFiles >= selectedFiles.length) {
    return selectedFiles;
  }
  return selectedFiles.slice(0, packetIncludedFiles);
}

export async function writeDirectReviewFromEnv(env = process.env, fetchImpl = globalThis.fetch) {
  const outputFile = cleanText(env.AI_REVIEW_OUTPUT_FILE || 'pr_review.md');
  const logFile = cleanText(env.AI_REVIEW_LOG_FILE || '.ccs-ai-review-attempts.json');
  const prompt = cleanText(env.AI_REVIEW_PROMPT);
  const packet = readTextFile(cleanText(env.AI_REVIEW_PACKET_FILE || '.ccs-ai-review-packet.md'));
  const selectedFiles = readSelectedFiles(
    cleanText(env.AI_REVIEW_SCOPE_MANIFEST_FILE || '.ccs-ai-review-selected-files.txt')
  );
  const includedManifestFiles = readSelectedFiles(
    cleanText(env.AI_REVIEW_PACKET_INCLUDED_MANIFEST_FILE || '.ccs-ai-review-packet-included-files.txt')
  );
  const timeoutMs = Number.parseInt(cleanText(env.AI_REVIEW_REQUEST_TIMEOUT_MS || '240000'), 10) || 240000;
  const timeoutMinutes = Number.parseInt(cleanText(env.AI_REVIEW_TIMEOUT_MINUTES || '0'), 10) || 0;
  const requestBufferMs = Number.parseInt(cleanText(env.AI_REVIEW_REQUEST_BUFFER_MS || '45000'), 10) || 45000;
  const minAttemptMs = Number.parseInt(cleanText(env.AI_REVIEW_REQUEST_MIN_MS || '20000'), 10) || 20000;
  const maxAttempts = Number.parseInt(cleanText(env.AI_REVIEW_MAX_ATTEMPTS || '3'), 10) || 3;
  const startedAt = Date.now();
  const rendering = {
    mode: env.AI_REVIEW_MODE,
    selectedFiles: env.AI_REVIEW_SELECTED_FILES,
    reviewableFiles: env.AI_REVIEW_REVIEWABLE_FILES,
    selectedChanges: env.AI_REVIEW_SELECTED_CHANGES,
    reviewableChanges: env.AI_REVIEW_REVIEWABLE_CHANGES,
    scopeLabel: env.AI_REVIEW_SCOPE_LABEL,
    timeoutMinutes: env.AI_REVIEW_TIMEOUT_MINUTES,
    packetIncludedFiles: env.AI_REVIEW_PACKET_INCLUDED_FILES,
    packetTotalFiles: env.AI_REVIEW_PACKET_TOTAL_FILES,
    packetOmittedFiles: env.AI_REVIEW_PACKET_OMITTED_FILES,
  };
  const packetIncludedFiles = Number.parseInt(cleanText(env.AI_REVIEW_PACKET_INCLUDED_FILES || '0'), 10) || 0;
  const coveredSelectedFiles = resolveCoveredSelectedFiles({
    selectedFiles,
    packetIncludedFiles,
    includedManifestFiles,
  });
  const meta = {
    repository: cleanText(env.GITHUB_REPOSITORY),
    prNumber: cleanText(env.AI_REVIEW_PR_NUMBER),
    baseRef: cleanText(env.AI_REVIEW_BASE_REF),
    headRef: cleanText(env.AI_REVIEW_HEAD_REF),
    headSha: cleanText(env.AI_REVIEW_HEAD_SHA),
    authorLogin: cleanText(env.AI_REVIEW_AUTHOR_LOGIN),
    authorAssociation: cleanText(env.AI_REVIEW_AUTHOR_ASSOCIATION),
    reviewMode: cleanText(env.AI_REVIEW_MODE),
    sizeClass: cleanText(env.AI_REVIEW_PR_SIZE_CLASS),
    changedFiles: cleanText(env.AI_REVIEW_CHANGED_FILES),
    additions: cleanText(env.AI_REVIEW_ADDITIONS),
    deletions: cleanText(env.AI_REVIEW_DELETIONS),
    totalChurn: cleanText(env.AI_REVIEW_TOTAL_CHURN),
  };
  const system = buildSystemPrompt(prompt);
  const attempts = [];
  let finalValidation = null;
  let lastReason = 'missing structured output';
  let previousCandidate = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptWindow = resolveAttemptWindow({
      timeoutMinutes,
      configuredTimeoutMs: timeoutMs,
      requestBufferMs,
      minAttemptMs,
      startedAt,
      now: Date.now(),
    });

    if (!attemptWindow.canAttempt || !attemptWindow.timeoutMs) {
      attempts.push({
        attempt,
        status: 'skipped_budget',
        validationReason: 'reserved remaining runtime for deterministic fallback publication',
        remainingMs: attemptWindow.remainingMs,
      });
      lastReason = 'review runtime budget reserved for deterministic fallback publication';
      break;
    }

    try {
      const attemptPrompt =
        attempt === 1
          ? buildPrimaryPrompt({ meta, packet })
          : `${buildPrimaryPrompt({ meta, packet })}\n\n${buildRepairPrompt({ validationReason: lastReason, previousCandidate })}`;
      const attemptStartedAt = new Date().toISOString();
      const responseJson = await postReviewRequest({
        apiUrl: cleanText(env.ANTHROPIC_BASE_URL),
        apiKey: cleanText(env.ANTHROPIC_AUTH_TOKEN),
        model: cleanText(env.REVIEW_MODEL || env.ANTHROPIC_MODEL || 'glm-5-turbo'),
        system,
        prompt: attemptPrompt,
        timeoutMs: attemptWindow.timeoutMs,
        fetchImpl,
      });
      const rawText = collectMessageText(responseJson);
      previousCandidate = extractJsonCandidate(rawText);
      const validation = normalizeStructuredOutput(previousCandidate);
      attempts.push({
        attempt,
        startedAt: attemptStartedAt,
        status: validation.ok ? 'validated' : 'invalid',
        timeoutMs: attemptWindow.timeoutMs,
        validationReason: validation.ok ? null : validation.reason,
        responsePreview: rawText.slice(0, 800),
      });
      if (validation.ok) {
        finalValidation = validation.value;
        break;
      }
      lastReason = validation.reason || lastReason;
    } catch (error) {
      attempts.push({
        attempt,
        status: 'error',
        timeoutMs: attemptWindow.timeoutMs,
        validationReason: error instanceof Error ? error.message : String(error),
      });
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  const markdown = finalValidation
    ? renderStructuredReview(finalValidation, {
        model: cleanText(env.REVIEW_MODEL || 'glm-5-turbo'),
        rendering,
      })
    : renderIncompleteReview({
        model: cleanText(env.REVIEW_MODEL || 'glm-5-turbo'),
        reason: lastReason,
        runUrl: cleanText(env.AI_REVIEW_RUN_URL || '#'),
        selectedFiles: coveredSelectedFiles,
        rendering,
        status: 'failure',
      });

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${markdown}\n`, 'utf8');
  fs.writeFileSync(logFile, `${JSON.stringify({ attempts, success: !!finalValidation }, null, 2)}\n`, 'utf8');

  return { usedFallback: !finalValidation, attempts };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const result = await writeDirectReviewFromEnv();
  if (result.usedFallback) {
    process.exitCode = 1;
  }
}
