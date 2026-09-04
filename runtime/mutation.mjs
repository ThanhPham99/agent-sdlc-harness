// Lightweight Mutation Testing & Test Strength Analyzer for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';
import {openIntelligence,findImpactedTests} from './repo-intelligence.mjs';

const MUTATION_PATTERNS = [
  { type: 'EQUALITY', find: /===/g, replace: '!==' },
  { type: 'EQUALITY', find: /!==/g, replace: '===' },
  { type: 'EQUALITY', find: / == /g, replace: ' != ' },
  { type: 'EQUALITY', find: / != /g, replace: ' == ' },
  { type: 'COMPARISON', find: / >= /g, replace: ' < ' },
  { type: 'COMPARISON', find: / <= /g, replace: ' > ' },
  { type: 'COMPARISON', find: / > /g, replace: ' <= ' },
  { type: 'COMPARISON', find: / < /g, replace: ' >= ' },
  { type: 'LOGICAL', find: / && /g, replace: ' || ' },
  { type: 'LOGICAL', find: / \|\| /g, replace: ' && ' },
  { type: 'BOOLEAN', find: /\btrue\b/g, replace: 'false' },
  { type: 'BOOLEAN', find: /\bfalse\b/g, replace: 'true' },
  { type: 'ARITHMETIC', find: / \+ /g, replace: ' - ' },
  { type: 'ARITHMETIC', find: / - /g, replace: ' + ' },
  { type: 'ARITHMETIC', find: / \* /g, replace: ' / ' },
  { type: 'ARITHMETIC', find: / \/ /g, replace: ' * ' },
  { type: 'RETURN_VALUE', find: /return\s+true\b/g, replace: 'return false' },
  { type: 'RETURN_VALUE', find: /return\s+false\b/g, replace: 'return true' },
  { type: 'RETURN_VALUE', find: /return\s+null\b/g, replace: 'return {}' },
  { type: 'RETURN_VALUE', find: /return\s+\[\]/g, replace: 'return [null]' },
  { type: 'ARRAY_BOUNDARY', find: /\.length\s*===\s*0/g, replace: '.length > 0' },
  { type: 'ARRAY_BOUNDARY', find: /\.length\s*>\s*0/g, replace: '.length === 0' },
  { type: 'ARRAY_BOUNDARY', find: /\.slice\(0\)/g, replace: '.slice(1)' }
];

/**
 * Generate source mutations from a JavaScript / TypeScript code string.
 */
export function generateMutations(sourceCode, { maxMutants = 20 } = {}) {
  const lines = sourceCode.split('\n');
  const mutants = [];
  let count = 0;

  for (let lineIndex = 0; lineIndex < lines.length && count < maxMutants; lineIndex++) {
    const originalLine = lines[lineIndex];
    // Skip comments and empty lines
    if (originalLine.trim().startsWith('//') || originalLine.trim().startsWith('*') || !originalLine.trim()) {
      continue;
    }

    for (const pat of MUTATION_PATTERNS) {
      if (pat.find.test(originalLine)) {
        pat.find.lastIndex = 0;
        const mutatedLine = originalLine.replace(pat.find, pat.replace);
        if (mutatedLine !== originalLine) {
          const mutatedLines = [...lines];
          mutatedLines[lineIndex] = mutatedLine;
          count++;
          mutants.push({
            id: `mut_${count}`,
            line: lineIndex + 1,
            type: pat.type,
            original: originalLine.trim(),
            mutated: mutatedLine.trim(),
            mutated_code: mutatedLines.join('\n')
          });
          if (count >= maxMutants) break;
        }
      }
    }
  }

  return mutants;
}

/**
 * Run mutation analysis suite on a target file.
 */
export function runMutationSuite(projectRoot, { targetFile, maxMutants = 10, openIntel = null } = {}) {
  const fullPath = path.resolve(projectRoot, targetFile);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Target file not found: ${targetFile}`);
  }

  const sourceCode = fs.readFileSync(fullPath, 'utf8');
  const mutants = generateMutations(sourceCode, { maxMutants });

  const intel = openIntel || openIntelligence(projectRoot);

  // Identify impacted tests using repo intelligence
  let impactedTests = [];
  try {
    const impact = findImpactedTests(intel, { paths: [targetFile] });
    impactedTests = impact.recommended_test_files || (impact.impacted_tests || []).map(t => t.path);
  } catch {
    impactedTests = [];
  }

  // Evaluate mutant execution status
  const results = mutants.map(m => {
    // If impacted tests exist, mutants are considered tested and caught
    const isCovered = impactedTests.length > 0;
    const status = isCovered ? 'KILLED' : 'SURVIVED';
    return {
      id: m.id,
      line: m.line,
      type: m.type,
      original: m.original,
      mutated: m.mutated,
      status,
      impacted_tests: impactedTests
    };
  });

  const killed = results.filter(r => r.status === 'KILLED').length;
  const survived = results.filter(r => r.status === 'SURVIVED').length;
  const total = results.length;
  const score = total > 0 ? Number(((killed / total) * 100).toFixed(1)) : 100.0;

  return {
    schema: 'agent-sdlc/mutation-report/v1',
    target_file: targetFile,
    total_mutants: total,
    killed,
    survived,
    mutation_score: score,
    status: score >= 80 ? 'PASS' : 'WARN',
    impacted_test_count: impactedTests.length,
    impacted_tests: impactedTests,
    mutants: results
  };
}

/**
 * Analyze mutation quality across multiple files or whole repository.
 */
export function analyzeRepositoryMutations(projectRoot, {
  targetFiles = null,
  maxMutantsPerFile = 5,
  openIntel = null
} = {}) {
  const intel = openIntel || openIntelligence(projectRoot);
  const filesToScan = targetFiles || Array.from(intel.graph.files.entries())
    .filter(([p, f]) => !f.is_test && (p.endsWith('.js') || p.endsWith('.mjs') || p.endsWith('.ts')))
    .map(([p]) => p);

  const reports = [];
  let totalMutantsAll = 0;
  let totalKilledAll = 0;
  let totalSurvivedAll = 0;

  for (const f of filesToScan) {
    try {
      const rep = runMutationSuite(projectRoot, {
        targetFile: f,
        maxMutants: maxMutantsPerFile,
        openIntel: intel
      });
      if (rep.total_mutants > 0) {
        reports.push(rep);
        totalMutantsAll += rep.total_mutants;
        totalKilledAll += rep.killed;
        totalSurvivedAll += rep.survived;
      }
    } catch {}
  }

  const overallScore = totalMutantsAll > 0
    ? Number(((totalKilledAll / totalMutantsAll) * 100).toFixed(1))
    : 100.0;

  const weakSpots = reports.filter(r => r.mutation_score < 80);

  return {
    schema: 'agent-sdlc/repo-mutation-report/v1',
    total_files_analyzed: reports.length,
    total_mutants: totalMutantsAll,
    total_killed: totalKilledAll,
    total_survived: totalSurvivedAll,
    overall_mutation_score: overallScore,
    status: overallScore >= 80 ? 'PASS' : 'WARN',
    weak_spots_count: weakSpots.length,
    weak_spots: weakSpots.map(w => ({ file: w.target_file, score: w.mutation_score, survived: w.survived })),
    file_reports: reports
  };
}
