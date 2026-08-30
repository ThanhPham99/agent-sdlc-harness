// Multi-Dimensional Static Code-Review & Security Persona Auditor for Agent SDLC Harness.
import fs from 'node:fs';
import path from 'node:path';

const AUDIT_RULES = [
  {
    id: 'SEC-001',
    dimension: 'security',
    severity: 'HIGH',
    name: 'Avoid eval() usage',
    pattern: /\beval\s*\(/g,
    message: 'Direct use of eval() allows arbitrary code execution.'
  },
  {
    id: 'SEC-002',
    dimension: 'security',
    severity: 'HIGH',
    name: 'Avoid Function constructor',
    pattern: /\bnew\s+Function\s*\(/g,
    message: 'Dynamic Function constructor can evaluate untrusted strings.'
  },
  {
    id: 'PERF-001',
    dimension: 'performance',
    severity: 'MEDIUM',
    name: 'Sync I/O in potentially asynchronous flow',
    pattern: /\bfs\.(?:readFileSync|writeFileSync|existsSync)\b/g,
    message: 'Synchronous file system operations can block the event loop in high-concurrency flows.'
  },
  {
    id: 'ARCH-001',
    dimension: 'architecture',
    severity: 'LOW',
    name: 'Function design: check parameter count',
    pattern: /function\s+[a-zA-Z0-9_$]+\s*\([^,)]+,[^,)]+,[^,)]+,[^,)]+\)/g,
    message: 'Functions should have at most 3 parameters; encapsulate in an options object.'
  },
  {
    id: 'REL-001',
    dimension: 'reliability',
    severity: 'MEDIUM',
    name: 'Unprotected JSON.parse',
    pattern: /(?<!try\s*\{[^}]*)\bJSON\.parse\s*\(/g,
    message: 'JSON.parse can throw SyntaxError; wrap in try/catch or helper.'
  }
];

function collectSourceFiles(dir, maxFiles = 100) {
  const files = [];
  function walk(current) {
    if (files.length >= maxFiles) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'dist') continue;
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (/\.(?:m?[jt]sx?|json)$/.test(ent.name)) {
        files.push(full);
        if (files.length >= maxFiles) break;
      }
    }
  }
  walk(dir);
  return files;
}

/**
 * Perform a static review audit across 5 dimensions.
 */
export function auditCodebase(projectRoot, { paths = [], strict = false } = {}) {
  const targetFiles = paths.length > 0
    ? paths.map(p => path.resolve(projectRoot, p)).filter(p => fs.existsSync(p))
    : collectSourceFiles(projectRoot);

  const findings = [];
  const dimensionCounts = { security: 0, performance: 0, architecture: 0, reliability: 0 };

  for (const file of targetFiles) {
    const relPath = path.relative(projectRoot, file).replace(/\\/g, '/');
    // Skip test fixtures and node_modules
    if (relPath.startsWith('.agent-sdlc') || relPath.startsWith('evals/fixtures')) continue;

    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineText = lines[lineIndex];
      // Skip comment lines
      if (lineText.trim().startsWith('//') || lineText.trim().startsWith('*')) continue;

      for (const rule of AUDIT_RULES) {
        if (rule.pattern.test(lineText)) {
          rule.pattern.lastIndex = 0;
          dimensionCounts[rule.dimension] = (dimensionCounts[rule.dimension] || 0) + 1;
          findings.push({
            rule_id: rule.id,
            dimension: rule.dimension,
            severity: rule.severity,
            name: rule.name,
            file: relPath,
            line: lineIndex + 1,
            snippet: lineText.trim(),
            message: rule.message
          });
        }
      }
    }
  }

  const secScore = Math.max(0, 100 - (dimensionCounts.security * 25));
  const perfScore = Math.max(0, 100 - (dimensionCounts.performance * 5));
  const archScore = Math.max(0, 100 - (dimensionCounts.architecture * 5));
  const relScore = Math.max(0, 100 - (dimensionCounts.reliability * 10));
  const overallScore = Math.round((secScore * 0.4) + (perfScore * 0.2) + (archScore * 0.2) + (relScore * 0.2));

  const status = (dimensionCounts.security === 0 && overallScore >= 75) ? 'PASS' : (strict ? 'FAIL' : 'WARN');

  return {
    schema: 'agent-sdlc/review-scorecard/v1',
    status,
    overall_score: overallScore,
    dimensions: {
      security: secScore,
      performance: perfScore,
      architecture: archScore,
      reliability: relScore
    },
    finding_count: findings.length,
    findings: findings.slice(0, 50)
  };
}
