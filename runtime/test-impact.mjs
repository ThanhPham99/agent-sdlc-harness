// Intelligent Test Impact Analysis (TIA) Engine for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Scan a test file for static imports or require calls targeting source files.
 */
function extractImportedPaths(testFilePath, content) {
  const imports = [];
  const dir = path.dirname(testFilePath);

  // Match import ... from '...' or require('...')
  const importRegex = /(?:import\s+.*?from\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const importSpecifier = match[1] || match[2];
    if (importSpecifier && importSpecifier.startsWith('.')) {
      const resolved = path.normalize(path.join(dir, importSpecifier));
      imports.push(resolved);
    }
  }
  return imports;
}

/**
 * Find all test files within a directory recursively.
 */
function findTestFiles(dir, extList = ['.mjs', '.js', '.ts', '.py', '.go']) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', '.agent-sdlc', '.tmp'].includes(entry.name)) {
        results.push(...findTestFiles(fullPath, extList));
      }
    } else if (entry.isFile()) {
      const isTest = /(?:test|spec)[\-_.]|[\\/]tests?[\\/]/i.test(fullPath);
      if (isTest && extList.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

/**
 * Analyze modified files and compute the minimal set of impacted tests.
 */
export function analyzeTestImpact(projectRoot, { modifiedFiles = [], testFiles = null } = {}) {
  const tests = testFiles || findTestFiles(projectRoot);
  const normalizedModified = modifiedFiles.map(f => path.normalize(path.resolve(projectRoot, f)));
  const modifiedBaseNames = new Set(modifiedFiles.map(f => path.basename(f, path.extname(f))));

  const impactedTests = [];

  for (const testPath of tests) {
    let content = '';
    try {
      content = fs.readFileSync(testPath, 'utf8');
    } catch {
      continue;
    }

    const imported = extractImportedPaths(testPath, content);
    let isImpacted = false;

    // Direct path match
    for (const imp of imported) {
      if (normalizedModified.some(m => m.startsWith(imp) || imp.startsWith(m))) {
        isImpacted = true;
        break;
      }
    }

    // Basename / symbolic match fallback
    if (!isImpacted) {
      for (const base of modifiedBaseNames) {
        if (content.includes(base)) {
          isImpacted = true;
          break;
        }
      }
    }

    if (isImpacted) {
      impactedTests.push(path.relative(projectRoot, testPath).replace(/\\/g, '/'));
    }
  }

  const totalTests = tests.length;
  const impactedCount = impactedTests.length;
  const savingsRatio = totalTests > 0 ? Number(((totalTests - impactedCount) / totalTests).toFixed(4)) : 0;

  return {
    schema: 'agent-sdlc/test-impact-report/v1',
    modified_files: modifiedFiles,
    total_test_count: totalTests,
    impacted_test_count: impactedCount,
    coverage_savings_ratio: savingsRatio,
    impacted_tests: impactedTests,
    all_tests_required: impactedCount === totalTests
  };
}