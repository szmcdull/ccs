import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSESSMENTS = {
  approved: '✅ APPROVED',
  approved_with_notes: '⚠️ APPROVED WITH NOTES',
  changes_requested: '❌ CHANGES REQUESTED',
};

const SEVERITY_ORDER = ['high', 'medium', 'low'];
const SEVERITY_HEADERS = {
  high: '### 🔴 High',
  medium: '### 🟡 Medium',
  low: '### 🟢 Low',
};
const SEVERITY_SUMMARY_LABELS = {
  high: '🔴 High',
  medium: '🟡 Medium',
  low: '🟢 Low',
};

const STATUS_LABELS = {
  pass: '✅',
  fail: '⚠️',
  na: 'N/A',
};

const REVIEW_MODE_DETAILS = {
  fast: 'selected-file packaged review',
  triage: 'expanded packaged review with broader coverage',
  deep: 'maintainer-triggered expanded packet review',
};

const RENDERER_OWNED_MARKUP_PATTERNS = [
  { pattern: /^#{1,6}\s/u, reason: 'markdown heading' },
  { pattern: /^\s*Verdict\s*:/iu, reason: 'verdict label' },
  { pattern: /^\s*PR\s*#?\d+\s*Review(?:\s*[:.-]|$)/iu, reason: 'ad hoc PR heading' },
  { pattern: /\|\s*[-:]+\s*\|/u, reason: 'markdown table' },
  { pattern: /```/u, reason: 'code fence' },
];

const INLINE_CODE_TOKEN_PATTERN =
  /\b[A-Za-z_][A-Za-z0-9_.]*\([^()\n]*\)|(?<![\w`])\.?[\w-]+(?:\/[\w.-]+)+\.[\w.-]+(?::\d+)?|\b[\w.-]+\/[\w.-]+@[\w.-]+\b|--[a-z0-9][a-z0-9-]*\b|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gu;
const CODE_BLOCK_LANGUAGE_PATTERN = /^[A-Za-z0-9#+.-]{1,20}$/u;
const MAX_FINDING_SNIPPETS = 2;
const MAX_SNIPPET_LINES = 20;
const MAX_SNIPPET_CHARACTERS = 1200;
const TOP_FINDINGS_LIMIT = 3;

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function cleanMultilineText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '');
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}[\]<>|])/g, '\\$1');
}

function escapeMarkdownText(value) {
  return escapeMarkdown(cleanText(value));
}

function renderCode(value) {
  const text = cleanText(value);
  const longestFence = Math.max(...[...text.matchAll(/`+/g)].map((match) => match[0].length), 0);
  const fence = '`'.repeat(longestFence + 1);
  return `${fence}${text}${fence}`;
}

function renderCodeBlock(value, language) {
  const text = cleanMultilineText(value);
  const longestFence = Math.max(...[...text.matchAll(/`+/gu)].map((match) => match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longestFence + 1));
  const info = cleanText(language);
  return `${fence}${info}\n${text}\n${fence}`;
}

function renderInlineText(value) {
  const text = cleanText(value);
  if (!text) {
    return '';
  }

  let rendered = '';
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_CODE_TOKEN_PATTERN)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index < lastIndex) {
      continue;
    }

    rendered += escapeMarkdown(text.slice(lastIndex, index));
    rendered += renderCode(token);
    lastIndex = index + token.length;
  }

  rendered += escapeMarkdown(text.slice(lastIndex));
  return rendered;
}

function parsePositiveInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number.parseInt(cleanText(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeReviewMode(value) {
  const mode = cleanText(value).toLowerCase();
  return REVIEW_MODE_DETAILS[mode] ? mode : null;
}

function normalizeRenderingMetadata(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }

  const mode = normalizeReviewMode(raw.mode);
  const maxTurns = parsePositiveInteger(raw.maxTurns);
  const timeoutMinutes = parsePositiveInteger(raw.timeoutMinutes);
  const timeoutSeconds = parsePositiveInteger(raw.timeoutSeconds);
  const selectedFiles = parsePositiveInteger(raw.selectedFiles);
  const reviewableFiles = parsePositiveInteger(raw.reviewableFiles);
  const selectedChanges = parsePositiveInteger(raw.selectedChanges);
  const reviewableChanges = parsePositiveInteger(raw.reviewableChanges);
  const packetIncludedFiles = parsePositiveInteger(raw.packetIncludedFiles);
  const packetTotalFiles = parsePositiveInteger(raw.packetTotalFiles);
  const packetOmittedFiles = parsePositiveInteger(raw.packetOmittedFiles);
  const scopeLabel = cleanText(raw.scopeLabel).toLowerCase();
  const metadata = {};

  if (mode) metadata.mode = mode;
  if (maxTurns) metadata.maxTurns = maxTurns;
  if (timeoutMinutes) metadata.timeoutMinutes = timeoutMinutes;
  if (timeoutSeconds) metadata.timeoutSeconds = timeoutSeconds;
  if (selectedFiles) metadata.selectedFiles = selectedFiles;
  if (reviewableFiles) metadata.reviewableFiles = reviewableFiles;
  if (selectedChanges) metadata.selectedChanges = selectedChanges;
  if (reviewableChanges) metadata.reviewableChanges = reviewableChanges;
  if (packetIncludedFiles !== null) metadata.packetIncludedFiles = packetIncludedFiles;
  if (packetTotalFiles !== null) metadata.packetTotalFiles = packetTotalFiles;
  if (packetOmittedFiles !== null) metadata.packetOmittedFiles = packetOmittedFiles;
  if (scopeLabel === 'reviewable files' || scopeLabel === 'changed files')
    metadata.scopeLabel = scopeLabel;

  return metadata;
}

function mergeRenderingMetadata(...sources) {
  const merged = {};
  for (const source of sources) {
    Object.assign(merged, normalizeRenderingMetadata(source));
  }
  return merged;
}

function formatTurnBudget(rendering) {
  return typeof rendering.maxTurns === 'number' ? `${rendering.maxTurns} turns` : null;
}

function formatTimeBudget(rendering) {
  if (typeof rendering.timeoutMinutes === 'number') {
    return `${rendering.timeoutMinutes} minute${rendering.timeoutMinutes === 1 ? '' : 's'}`;
  }

  if (typeof rendering.timeoutSeconds === 'number') {
    return `${rendering.timeoutSeconds} second${rendering.timeoutSeconds === 1 ? '' : 's'}`;
  }

  return null;
}

function formatCombinedBudget(rendering) {
  const parts = [formatTurnBudget(rendering), formatTimeBudget(rendering)].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : null;
}

function formatScopeSummary(rendering) {
  if (
    typeof rendering.selectedFiles !== 'number' ||
    typeof rendering.reviewableFiles !== 'number'
  ) {
    return null;
  }

  const scopeLabel = rendering.scopeLabel || 'reviewable files';
  const fileScope = `${rendering.selectedFiles}/${rendering.reviewableFiles} ${scopeLabel}`;
  if (
    typeof rendering.selectedChanges === 'number' &&
    typeof rendering.reviewableChanges === 'number'
  ) {
    const changeLabel =
      scopeLabel === 'reviewable files' ? 'reviewable changed lines' : 'changed lines';
    return `${fileScope}; ${rendering.selectedChanges}/${rendering.reviewableChanges} ${changeLabel}`;
  }

  return fileScope;
}

function formatPacketCoverage(rendering) {
  if (
    typeof rendering.packetIncludedFiles !== 'number' ||
    typeof rendering.packetTotalFiles !== 'number'
  ) {
    return null;
  }

  const packetSummary = `${rendering.packetIncludedFiles}/${rendering.packetTotalFiles} selected files included in the final review packet`;
  if (typeof rendering.packetOmittedFiles === 'number' && rendering.packetOmittedFiles > 0) {
    return `${packetSummary}; ${rendering.packetOmittedFiles} selected file${rendering.packetOmittedFiles === 1 ? '' : 's'} omitted for packet budget`;
  }

  return packetSummary;
}

function formatReviewContext(rendering) {
  const parts = [];

  if (rendering.mode) {
    parts.push(renderCode(rendering.mode));
  }

  if (
    typeof rendering.selectedFiles === 'number' &&
    typeof rendering.reviewableFiles === 'number'
  ) {
    parts.push(`${rendering.selectedFiles}/${rendering.reviewableFiles} files`);
  }

  if (
    typeof rendering.selectedChanges === 'number' &&
    typeof rendering.reviewableChanges === 'number'
  ) {
    parts.push(`${rendering.selectedChanges}/${rendering.reviewableChanges} lines`);
  }

  if (
    typeof rendering.packetIncludedFiles === 'number' &&
    typeof rendering.packetTotalFiles === 'number'
  ) {
    parts.push(`packet ${rendering.packetIncludedFiles}/${rendering.packetTotalFiles}`);
  }

  const runtimeBudget =
    formatCombinedBudget(rendering) || formatTimeBudget(rendering) || formatTurnBudget(rendering);
  if (runtimeBudget) {
    parts.push(runtimeBudget);
  }

  if (parts.length === 0) {
    return null;
  }

  return `> 🧭 ${parts.join(' • ')}`;
}

function classifyFallbackReason(reason) {
  const normalized = cleanText(reason).toLowerCase();
  if (!normalized || normalized === 'missing structured output') {
    return 'missing';
  }

  if (normalized === 'structured output is not valid json') {
    return 'invalid_json';
  }

  return 'invalid_fields';
}

function describeIncompleteOutcome({ reason, rendering, turnsUsed, status }) {
  const reviewLabel = rendering.mode ? `${renderCode(rendering.mode)} review` : 'bounded review';
  const turnBudget = formatTurnBudget(rendering);
  const timeBudget = formatTimeBudget(rendering);
  const combinedBudget = formatCombinedBudget(rendering);
  const exhaustedTurnBudget =
    typeof turnsUsed === 'number' &&
    typeof rendering.maxTurns === 'number' &&
    turnsUsed >= rendering.maxTurns;

  if (status === 'cancelled' && timeBudget) {
    return `The ${reviewLabel} hit the workflow runtime cap before it produced validated structured output. The run stayed bounded to ${timeBudget}.`;
  }

  if (exhaustedTurnBudget) {
    return `The ${reviewLabel} reached its ${rendering.maxTurns}-turn runtime budget before it produced validated structured output.`;
  }

  if (combinedBudget && classifyFallbackReason(reason) === 'missing') {
    return `The ${reviewLabel} ended before it could produce validated structured output within the available ${combinedBudget} runtime budget.`;
  }

  if (
    classifyFallbackReason(reason) === 'missing' ||
    classifyFallbackReason(reason) === 'invalid_json'
  ) {
    return `The ${reviewLabel} ended without validated structured output, so the normalizer published the safe fallback comment instead.`;
  }

  return `The ${reviewLabel} returned incomplete structured data, so the normalizer published the safe fallback comment instead.`;
}

function validatePlainTextField(fieldName, value) {
  const text = cleanText(value);
  if (!text) {
    return { ok: false, reason: `${fieldName} is required` };
  }

  const match = RENDERER_OWNED_MARKUP_PATTERNS.find(({ pattern }) => pattern.test(text));
  if (match) {
    return { ok: false, reason: `${fieldName} contains ${match.reason}` };
  }

  return { ok: true, value: text };
}

function normalizeStringList(fieldName, raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${fieldName} must be an array` };
  }

  const values = [];
  for (const [index, item] of raw.entries()) {
    const validation = validatePlainTextField(`${fieldName}[${index}]`, item);
    if (!validation.ok) return validation;
    values.push(validation.value);
  }

  return { ok: true, value: values };
}

function normalizeChecklistRows(fieldName, labelField, raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${fieldName} must be an array` };
  }

  const rows = [];
  for (const [index, item] of raw.entries()) {
    const label = validatePlainTextField(
      `${fieldName}[${index}].${labelField}`,
      item?.[labelField]
    );
    if (!label.ok) return label;

    const notes = validatePlainTextField(`${fieldName}[${index}].notes`, item?.notes);
    if (!notes.ok) return notes;

    const status = cleanText(item?.status).toLowerCase();
    if (!STATUS_LABELS[status]) {
      return { ok: false, reason: `${fieldName}[${index}].status is invalid` };
    }

    rows.push({ [labelField]: label.value, status, notes: notes.value });
  }

  if (rows.length === 0) {
    return { ok: false, reason: `${fieldName} must contain at least 1 item` };
  }

  return { ok: true, value: rows };
}

function normalizeFindingSnippets(fieldName, raw) {
  if (raw === null || raw === undefined) {
    return { ok: true, value: [] };
  }

  if (!Array.isArray(raw)) {
    return { ok: false, reason: `${fieldName} must be an array` };
  }

  if (raw.length > MAX_FINDING_SNIPPETS) {
    return {
      ok: false,
      reason: `${fieldName} must contain at most ${MAX_FINDING_SNIPPETS} snippets`,
    };
  }

  const snippets = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, reason: `${fieldName}[${index}] must be an object` };
    }

    let label = null;
    if (Object.hasOwn(item, 'label') && item.label !== null && item.label !== undefined) {
      const labelValidation = validatePlainTextField(`${fieldName}[${index}].label`, item.label);
      if (!labelValidation.ok) return labelValidation;
      label = labelValidation.value;
    }

    let language = null;
    if (Object.hasOwn(item, 'language') && item.language !== null && item.language !== undefined) {
      const normalizedLanguage = cleanText(item.language).toLowerCase();
      if (normalizedLanguage) {
        if (!CODE_BLOCK_LANGUAGE_PATTERN.test(normalizedLanguage)) {
          return { ok: false, reason: `${fieldName}[${index}].language is invalid` };
        }
        language = normalizedLanguage;
      }
    }

    const code = cleanMultilineText(item.code);
    if (!code) {
      return { ok: false, reason: `${fieldName}[${index}].code is required` };
    }
    if (code.length > MAX_SNIPPET_CHARACTERS) {
      return {
        ok: false,
        reason: `${fieldName}[${index}].code exceeds ${MAX_SNIPPET_CHARACTERS} characters`,
      };
    }

    const lineCount = code.split('\n').length;
    if (lineCount > MAX_SNIPPET_LINES) {
      return {
        ok: false,
        reason: `${fieldName}[${index}].code exceeds ${MAX_SNIPPET_LINES} lines`,
      };
    }

    const snippet = { code };
    if (label) snippet.label = label;
    if (language) snippet.language = language;
    snippets.push(snippet);
  }

  return { ok: true, value: snippets };
}

function readExecutionMetadata(executionFile) {
  if (!executionFile || !fs.existsSync(executionFile)) {
    return {};
  }

  try {
    const turns = JSON.parse(fs.readFileSync(executionFile, 'utf8'));
    const init = turns.find((turn) => turn?.type === 'system' && turn?.subtype === 'init');
    const result = [...turns].reverse().find((turn) => turn?.type === 'result');
    return {
      runtimeTools: Array.isArray(init?.tools) ? init.tools : [],
      turnsUsed: typeof result?.num_turns === 'number' ? result.num_turns : null,
    };
  } catch {
    return {};
  }
}

function readSelectedFiles(manifestFile) {
  if (!manifestFile || !fs.existsSync(manifestFile)) {
    return [];
  }

  try {
    return fs
      .readFileSync(manifestFile, 'utf8')
      .split('\n')
      .map((line) => cleanText(line))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatHotspotFiles(files) {
  if (!files.length) {
    return null;
  }

  const visible = files.slice(0, 4).map(renderCode).join(', ');
  return files.length > 4 ? `${visible}, and ${files.length - 4} more` : visible;
}

function formatRemainingCoverage(rendering) {
  if (
    typeof rendering.reviewableFiles !== 'number' ||
    (typeof rendering.packetIncludedFiles !== 'number' &&
      typeof rendering.selectedFiles !== 'number')
  ) {
    return null;
  }

  const coveredFiles =
    typeof rendering.packetIncludedFiles === 'number'
      ? rendering.packetIncludedFiles
      : rendering.selectedFiles;
  const remainingFiles = Math.max(rendering.reviewableFiles - coveredFiles, 0);
  const packetOmittedFiles =
    typeof rendering.packetOmittedFiles === 'number' ? rendering.packetOmittedFiles : 0;
  const hasChangeCounts =
    packetOmittedFiles === 0 &&
    typeof rendering.selectedChanges === 'number' &&
    typeof rendering.reviewableChanges === 'number';
  const remainingChanges = hasChangeCounts
    ? Math.max(rendering.reviewableChanges - rendering.selectedChanges, 0)
    : null;

  if (remainingFiles === 0 && (!hasChangeCounts || remainingChanges === 0)) {
    return null;
  }

  if (typeof remainingChanges === 'number') {
    return `${remainingFiles} file${remainingFiles === 1 ? '' : 's'}; ${remainingChanges} changed lines`;
  }

  return `${remainingFiles} file${remainingFiles === 1 ? '' : 's'}`;
}

function formatFallbackFollowUp(rendering) {
  if (rendering.mode === 'triage') {
    return 'Focus manual review on the selected files above, and use `/review` for a deeper pass when release, auth, config, or workflow paths changed.';
  }

  return 'Use `/review` when you need a deeper maintainer rerun with more surrounding context.';
}

export function normalizeStructuredOutput(raw) {
  if (!raw) {
    return { ok: false, reason: 'missing structured output' };
  }

  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'structured output is not valid JSON' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'structured output must be an object' };
  }

  const summary = validatePlainTextField('summary', parsed.summary);
  if (!summary.ok) return summary;

  const overallAssessment = cleanText(parsed.overallAssessment).toLowerCase();
  const overallRationale = validatePlainTextField('overallRationale', parsed.overallRationale);
  if (!overallRationale.ok) return overallRationale;

  const findings = Array.isArray(parsed.findings) ? parsed.findings : null;
  const securityChecklist = normalizeChecklistRows(
    'securityChecklist',
    'check',
    parsed.securityChecklist
  );
  if (!securityChecklist.ok) return securityChecklist;

  const ccsCompliance = normalizeChecklistRows('ccsCompliance', 'rule', parsed.ccsCompliance);
  if (!ccsCompliance.ok) return ccsCompliance;

  const informational = normalizeStringList('informational', parsed.informational);
  if (!informational.ok) return informational;

  const strengths = normalizeStringList('strengths', parsed.strengths);
  if (!strengths.ok) return strengths;

  const rendering = normalizeRenderingMetadata(parsed.rendering);

  if (!ASSESSMENTS[overallAssessment] || findings === null) {
    return { ok: false, reason: 'structured output is missing required review fields' };
  }

  const normalizedFindings = [];
  for (const [index, finding] of findings.entries()) {
    const severity = cleanText(finding?.severity).toLowerCase();
    const title = validatePlainTextField(`findings[${index}].title`, finding?.title);
    if (!title.ok) return title;

    const file = validatePlainTextField(`findings[${index}].file`, finding?.file);
    if (!file.ok) return file;

    const what = validatePlainTextField(`findings[${index}].what`, finding?.what);
    if (!what.ok) return what;

    const why = validatePlainTextField(`findings[${index}].why`, finding?.why);
    if (!why.ok) return why;

    const fix = validatePlainTextField(`findings[${index}].fix`, finding?.fix);
    if (!fix.ok) return fix;
    const snippets = normalizeFindingSnippets(`findings[${index}].snippets`, finding?.snippets);
    if (!snippets.ok) return snippets;

    let line = null;
    if (finding && Object.hasOwn(finding, 'line')) {
      if (finding.line === null) {
        line = null;
      } else if (
        typeof finding.line === 'number' &&
        Number.isInteger(finding.line) &&
        finding.line > 0
      ) {
        line = finding.line;
      } else {
        return { ok: false, reason: `findings[${index}].line is invalid` };
      }
    }

    if (!SEVERITY_HEADERS[severity]) {
      return { ok: false, reason: `findings[${index}].severity is invalid` };
    }

    normalizedFindings.push({
      severity,
      title: title.value,
      file: file.value,
      line,
      what: what.value,
      why: why.value,
      fix: fix.value,
      snippets: snippets.value,
    });
  }

  const value = {
    summary: summary.value,
    findings: normalizedFindings,
    overallAssessment,
    overallRationale: overallRationale.value,
    securityChecklist: securityChecklist.value,
    ccsCompliance: ccsCompliance.value,
    informational: informational.value,
    strengths: strengths.value,
  };

  if (Object.keys(rendering).length > 0) {
    value.rendering = rendering;
  }

  return { ok: true, value };
}

function renderChecklistTable(labelHeader, labelKey, rows) {
  const lines = [`| ${labelHeader} | Status | Notes |`, '|---|---|---|'];
  for (const row of rows) {
    lines.push(
      `| ${renderInlineText(row[labelKey])} | ${STATUS_LABELS[row.status]} | ${renderInlineText(row.notes)} |`
    );
  }
  return lines;
}

function renderBulletSection(items) {
  if (items.length === 0) return [];
  return items.map((item) => `- ${renderInlineText(item)}`);
}

function renderFindingSnippets(snippets) {
  if (!Array.isArray(snippets) || snippets.length === 0) {
    return [];
  }

  const lines = [];
  for (const snippet of snippets) {
    const label = snippet.label ? `Evidence: ${renderInlineText(snippet.label)}` : 'Evidence:';
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(label, '', ...renderCodeBlock(snippet.code, snippet.language).split('\n'));
  }

  return lines;
}

function renderSection(title, bodyLines) {
  if (!bodyLines.length) {
    return [];
  }

  return ['', title, '', ...bodyLines];
}

function renderFindingReference(finding) {
  return finding.line ? `${finding.file}:${finding.line}` : finding.file;
}

function getOrderedFindings(findings) {
  return SEVERITY_ORDER.flatMap((severity) =>
    findings.filter((finding) => finding.severity === severity)
  );
}

function renderTopFindings(findings) {
  if (findings.length === 0) {
    return ['No confirmed issues found after reviewing the diff and surrounding code.'];
  }

  const orderedFindings = getOrderedFindings(findings);
  const lines = orderedFindings
    .slice(0, TOP_FINDINGS_LIMIT)
    .map(
      (finding) =>
        `- ${SEVERITY_SUMMARY_LABELS[finding.severity]} ${renderCode(renderFindingReference(finding))} — ${renderInlineText(finding.title)}`
    );

  if (orderedFindings.length > TOP_FINDINGS_LIMIT) {
    const remaining = orderedFindings.length - TOP_FINDINGS_LIMIT;
    lines.push(`- ${remaining} more finding${remaining === 1 ? '' : 's'} in the details below.`);
  }

  return lines;
}

function renderDetailedFindings(findings) {
  if (findings.length === 0) {
    return [];
  }

  const lines = [];
  for (const severity of SEVERITY_ORDER) {
    const scopedFindings = findings.filter((finding) => finding.severity === severity);
    if (scopedFindings.length === 0) continue;

    lines.push(`**${SEVERITY_SUMMARY_LABELS[severity]} (${scopedFindings.length})**`, '');
    for (const [index, finding] of scopedFindings.entries()) {
      const snippets = Array.isArray(finding.snippets) ? finding.snippets : [];
      lines.push(`#### ${index + 1}. ${renderInlineText(finding.title)}`);
      lines.push(`- Location: ${renderCode(renderFindingReference(finding))}`);
      lines.push(`- Impact: ${renderInlineText(finding.why)}`);
      lines.push(`- Problem: ${renderInlineText(finding.what)}`);
      lines.push(`- Fix: ${renderInlineText(finding.fix)}`);
      if (snippets.length > 0) {
        lines.push('', ...renderFindingSnippets(snippets));
      }
      lines.push('');
    }
  }

  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines;
}

export function renderStructuredReview(review, { model, rendering: renderOptions } = {}) {
  const rendering = mergeRenderingMetadata(review?.rendering, renderOptions);
  const lines = ['### 📋 Summary', '', renderInlineText(review.summary)];
  const reviewContext = formatReviewContext(rendering);

  if (reviewContext) {
    lines.push('', reviewContext);
  }

  lines.push('', '### 🔍 Findings');
  if (review.findings.length === 0) {
    lines.push('', 'No confirmed issues found after reviewing the diff and surrounding code.');
  } else {
    for (const severity of SEVERITY_ORDER) {
      const scopedFindings = review.findings.filter((finding) => finding.severity === severity);
      if (scopedFindings.length === 0) continue;

      lines.push('', SEVERITY_HEADERS[severity], '');
      for (const finding of scopedFindings) {
        const snippets = Array.isArray(finding.snippets) ? finding.snippets : [];
        lines.push(
          `- **${renderCode(renderFindingReference(finding))} — ${renderInlineText(finding.title)}**`
        );
        lines.push(`  Problem: ${renderInlineText(finding.what)}`);
        lines.push(`  Why it matters: ${renderInlineText(finding.why)}`);
        lines.push(`  Suggested fix: ${renderInlineText(finding.fix)}`);

        if (snippets.length > 0) {
          lines.push('');
          lines.push(...renderFindingSnippets(snippets));
        }

        lines.push('');
      }
    }

    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
  }

  lines.push(
    ...renderSection(
      '### 🔒 Security Checklist',
      renderChecklistTable('Check', 'check', review.securityChecklist)
    )
  );
  lines.push(
    ...renderSection(
      '### 📊 CCS Compliance',
      renderChecklistTable('Rule', 'rule', review.ccsCompliance)
    )
  );
  lines.push(...renderSection('### 💡 Informational', renderBulletSection(review.informational)));
  lines.push(...renderSection("### ✅ What's Done Well", renderBulletSection(review.strengths)));

  lines.push(
    '',
    '### 🎯 Overall Assessment',
    '',
    `**${ASSESSMENTS[review.overallAssessment]}** — ${renderInlineText(review.overallRationale)}`,
    '',
    `> 🤖 Reviewed by \`${model}\``
  );

  return lines.join('\n');
}

export function renderIncompleteReview({
  model,
  reason,
  runUrl,
  runtimeTools,
  turnsUsed,
  selectedFiles,
  rendering: renderOptions,
  status,
}) {
  const rendering = mergeRenderingMetadata(renderOptions);
  const lines = [
    '### ⚠️ AI Review Incomplete',
    '',
    'Claude did not return validated structured review output, so this workflow published deterministic hotspot context instead of raw scratch text.',
    '',
    `- Outcome: ${describeIncompleteOutcome({ reason, rendering, turnsUsed, status })}`,
  ];

  if (rendering.mode) {
    lines.push(
      `- Review mode: ${renderCode(rendering.mode)} (${escapeMarkdownText(REVIEW_MODE_DETAILS[rendering.mode])})`
    );
  }
  const scopeSummary = formatScopeSummary(rendering);
  if (scopeSummary) {
    lines.push(`- Review scope: ${escapeMarkdownText(scopeSummary)}`);
  }
  const packetCoverage = formatPacketCoverage(rendering);
  if (packetCoverage) {
    lines.push(`- Packet coverage: ${escapeMarkdownText(packetCoverage)}`);
  }
  const runtimeBudget = formatCombinedBudget(rendering);
  if (runtimeBudget) {
    lines.push(`- Runtime budget: ${escapeMarkdownText(runtimeBudget)}`);
  }
  const hotspotFiles = formatHotspotFiles(selectedFiles || []);
  if (hotspotFiles) {
    lines.push(`- Hotspot files in this pass: ${hotspotFiles}`);
  }
  const remainingCoverage = formatRemainingCoverage(rendering);
  if (remainingCoverage) {
    lines.push(
      `- Remaining reviewable scope not fully covered: ${escapeMarkdownText(remainingCoverage)}`
    );
  }
  lines.push(`- Manual follow-up: ${escapeMarkdownText(formatFallbackFollowUp(rendering))}`);
  if (runtimeTools?.length) {
    lines.push(`- Runtime tools: ${runtimeTools.map(renderCode).join(', ')}`);
  }
  if (typeof turnsUsed === 'number') {
    lines.push(`- Turns used: ${turnsUsed}`);
  }

  lines.push(
    '',
    `Re-run \`/review\` or inspect [the workflow run](${runUrl}).`,
    '',
    `> 🤖 Reviewed by \`${model}\``
  );
  return lines.join('\n');
}

export function writeReviewFromEnv(env = process.env) {
  const outputFile = env.AI_REVIEW_OUTPUT_FILE || 'pr_review.md';
  const model = env.AI_REVIEW_MODEL || 'unknown-model';
  const runUrl = env.AI_REVIEW_RUN_URL || '#';
  const validation = normalizeStructuredOutput(env.AI_REVIEW_STRUCTURED_OUTPUT);
  const metadata = readExecutionMetadata(env.AI_REVIEW_EXECUTION_FILE);
  const selectedFiles = readSelectedFiles(env.AI_REVIEW_SCOPE_MANIFEST_FILE);
  const status = cleanText(env.AI_REVIEW_STATUS).toLowerCase() || null;
  const rendering = normalizeRenderingMetadata({
    mode: env.AI_REVIEW_MODE,
    selectedFiles: env.AI_REVIEW_SELECTED_FILES,
    reviewableFiles: env.AI_REVIEW_REVIEWABLE_FILES,
    selectedChanges: env.AI_REVIEW_SELECTED_CHANGES,
    reviewableChanges: env.AI_REVIEW_REVIEWABLE_CHANGES,
    packetIncludedFiles: env.AI_REVIEW_PACKET_INCLUDED_FILES,
    packetTotalFiles: env.AI_REVIEW_PACKET_TOTAL_FILES,
    packetOmittedFiles: env.AI_REVIEW_PACKET_OMITTED_FILES,
    scopeLabel: env.AI_REVIEW_SCOPE_LABEL,
    maxTurns: env.AI_REVIEW_MAX_TURNS,
    timeoutMinutes: env.AI_REVIEW_TIMEOUT_MINUTES ?? env.AI_REVIEW_TIMEOUT_MINUTES_BUDGET,
    timeoutSeconds: env.AI_REVIEW_TIMEOUT_SECONDS ?? env.AI_REVIEW_TIMEOUT_SEC,
  });
  const content = validation.ok
    ? renderStructuredReview(validation.value, { model, rendering })
    : renderIncompleteReview({
        model,
        reason: validation.reason,
        runUrl,
        runtimeTools: metadata.runtimeTools,
        turnsUsed: metadata.turnsUsed,
        selectedFiles,
        rendering,
        status,
      });

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, `${content}\n`, 'utf8');

  if (!validation.ok) {
    console.warn(
      `::warning::AI review output normalization fell back to incomplete comment: ${validation.reason}`
    );
  }

  return { usedFallback: !validation.ok, content };
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  writeReviewFromEnv();
}
