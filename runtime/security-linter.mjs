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
  },
  {
    id: 'HARDCODED_SECRET',
    severity: 'HIGH',
    description: 'Hardcoded credentials, private key, AWS token, or API key in source',
    regex: /-----BEGIN (?:RSA )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|Bearer\s+ey[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g
  },
  {
    id: 'PATH_TRAVERSAL',
    severity: 'HIGH',
    description: 'Potential path traversal via parent directory navigation or unsanitized fs calls',
    regex: /path\.(?:join|resolve)\s*\([^)]*['"]\.\.\/|fs\.(?:readFile|readFileSync|writeFile|writeFileSync)\s*\(\s*(?:['"][^'"]*['"]\s*\+|`[^`]*\${)/g
  },
  {
    id: 'TIMING_ATTACK',
    severity: 'MEDIUM',
    description: 'Insecure direct string comparison on secret/token; prefer crypto.timingSafeEqual',
    regex: /\b[a-zA-Z0-9_]*(?:token|secret|signature|hash|apiKey|password)[a-zA-Z0-9_]*\s*===|===\s*[a-zA-Z0-9_]*(?:token|secret|signature|hash|apiKey|password)[a-zA-Z0-9_]*/i
  },
  {
    id: 'INSECURE_RANDOMNESS',
    severity: 'MEDIUM',
    description: 'Insecure random number generation for security-sensitive tokens/secrets; prefer crypto.randomBytes',
    regex: /Math\.random\s*\(\)\s*\.\s*toString\s*\(\s*36\s*\)|\b(?:token|secret|salt|nonce|apiKey)\s*=\s*[^;\n]*Math\.random/g
  }
];

/**
 * Lint source code string for deterministic security issues.
 */
export function lintSecurityRisks(codeString, { filename = 'code.js' } = {}) {
  const code = String(codeString || '');
  const findings = [];

  for (const rule of SECURITY_RULES) {
    const flags = rule.regex.flags.includes('g') ? rule.regex.flags : rule.regex.flags + 'g';
    const rx = new RegExp(rule.regex.source, flags);
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