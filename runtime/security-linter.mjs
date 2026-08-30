// Deterministic Static Security Linter for Agent SDLC Harness.
// Analyzes code snippets and AST patterns to catch vulnerabilities before AI review.

const SECURITY_RULES = [
  {
    id: 'EVAL_EXECUTION',
    severity: 'HIGH',
    description: 'Dynamic code execution via eval() or Function constructor',
    regex: /\b(?:eval\s*\(|new\s+Function\s*\()/g
  },
  {
    id: 'UNSAFE_HTML_INJECTION',
    severity: 'MEDIUM',
    description: 'Direct HTML injection susceptible to XSS (innerHTML / document.write)',
    regex: /\b(?:innerHTML|outerHTML)\s*=|document\.write(?:ln)?\s*\(/g
  },
  {
    id: 'COMMAND_INJECTION_RISK',
    severity: 'HIGH',
    description: 'Command string concatenation inside exec/execSync without sanitization',
    regex: /\b(?:exec|execSync)\s*\(\s*(?:`[^`]*\${|['"][^'"]*['"]\s*\+)/g
  },
  {
    id: 'PROTOTYPE_POLLUTION',
    severity: 'HIGH',
    description: 'Modification of Object prototype or __proto__ property',
    regex: /\[['"]__proto__['"]\]|\.__proto__\b|constructor\.prototype/g
  },
  {
    id: 'REDOS_VULNERABLE_REGEX',
    severity: 'MEDIUM',
    description: 'Nested repetitive quantifiers in Regular Expression prone to ReDoS',
    regex: /\((?:[^()]+\+)+\)\+/g
  }
];

/**
 * Lint source code string for deterministic security issues.
 */
export function lintSecurityRisks(codeString, { filename = 'code.js' } = {}) {
  const code = String(codeString || '');
  const findings = [];

  for (const rule of SECURITY_RULES) {
    const rx = new RegExp(rule.regex.source, 'g');
    let match;
    while ((match = rx.exec(code)) !== null) {
      // Find line number
      const lineNum = code.slice(0, match.index).split('\n').length;
      findings.push({
        rule_id: rule.id,
        severity: rule.severity,
        description: rule.description,
        line: lineNum,
        matched: match[0].slice(0, 40)
      });
    }
  }

  const hasHigh = findings.some(f => f.severity === 'HIGH');
  const hasMedium = findings.some(f => f.severity === 'MEDIUM');
  const riskLevel = hasHigh ? 'HIGH' : hasMedium ? 'MEDIUM' : 'LOW';

  return {
    schema: 'agent-sdlc/security-lint-report/v1',
    filename,
    clean: findings.length === 0,
    risk_level: riskLevel,
    findings_count: findings.length,
    findings
  };
}