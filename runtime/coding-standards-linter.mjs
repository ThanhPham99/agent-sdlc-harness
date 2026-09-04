// Coding Standards and Clean Code Linter for Agent SDLC Harness.
// Enforces policies/coding-standards.json deterministically with zero runtime dependencies.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_POLICY_PATH = 'policies/coding-standards.json';
const ALLOWED_BOOLEAN_PREFIXES = ['is_', 'has_', 'can_', 'should_'];

/**
 * Loads and validates the coding standards policy.
 */
export function loadCodingStandardsPolicy(root_dir = process.cwd(), custom_relative_path = DEFAULT_POLICY_PATH) {
  const policy_abs_path = path.resolve(root_dir, custom_relative_path);
  if (!fs.existsSync(policy_abs_path)) {
    throw new Error(`Coding standards policy not found at: ${policy_abs_path}`);
  }
  try {
    const raw_content = fs.readFileSync(policy_abs_path, 'utf8');
    const parsed_policy = JSON.parse(raw_content);
    if (!parsed_policy.schema || !parsed_policy.schema.startsWith('agent-sdlc/coding-standards-policy/')) {
      throw new Error(`Invalid schema in coding standards policy: ${parsed_policy.schema}`);
    }
    return parsed_policy;
  } catch (error) {
    throw new Error(`Failed to parse coding standards policy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Checks if a filename matches kebab-case convention.
 */
export function checkFilenameConvention(relative_path) {
  const file_name = path.basename(relative_path);
  // Strip extension and leading dot for hidden files
  const name_without_ext = file_name.replace(/^\./, '').split('.')[0];
  if (!name_without_ext) {
    return { is_valid: true };
  }
  // Allow kebab-case with numbers and optional underscores for specific schemas/namespaces
  const is_kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name_without_ext) ||
                  /^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(name_without_ext); // allow special uppercase names like README, VERSION
  return {
    is_valid: is_kebab,
    file_name,
    name_without_ext
  };
}

/**
 * Audits a single file's content against coding standards rules.
 */
export function auditFileContent(file_path, content, policy = null) {
  const violations = [];
  const lines = String(content || '').split('\n');

  // Rule 1: No 'var' declarations (Immutability & Modern JS)
  lines.forEach((line, line_index) => {
    const trimmed_line = line.trim();
    if (trimmed_line.startsWith('//') || trimmed_line.startsWith('*')) {
      return;
    }
    if (/\bvar\s+[a-zA-Z0-9_$]+/.test(line)) {
      violations.push({
        file_path,
        line_number: line_index + 1,
        rule_id: 'NO_VAR_DECLARATION',
        severity: 'BLOCKING',
        message: 'Use const (or let if reassignable) instead of var.',
        snippet: trimmed_line
      });
    }
  });

  // Rule 2: Strict Typing - No 'any' type in TS / JSDoc annotations
  lines.forEach((line, line_index) => {
    const trimmed_line = line.trim();
    if (trimmed_line.startsWith('//')) {
      return;
    }
    // Match ': any' or 'as any' or JSDoc '@type {any}' or '@param {any}'
    const has_any_type = /:\s*any\b/.test(line) ||
                         /\bas\s+any\b/.test(line) ||
                         /\*\s*@(?:type|param|returns?)\s*\{[^}]*\bany\b[^}]*\}/.test(line);
    if (has_any_type) {
      violations.push({
        file_path,
        line_number: line_index + 1,
        rule_id: 'NO_ANY_TYPE',
        severity: 'BLOCKING',
        message: 'Strict typing violation: avoid "any". Use specific types or "unknown" with type guards.',
        snippet: trimmed_line
      });
    }
  });

  // Rule 3: Function parameter limit (max 3 parameters)
  lines.forEach((line, line_index) => {
    const trimmed_line = line.trim();
    if (trimmed_line.startsWith('//') || trimmed_line.startsWith('*')) {
      return;
    }
    // Match function declarations: function name(p1, p2, p3, p4) or (p1, p2, p3, p4) =>
    const func_match = trimmed_line.match(/(?:function\s+[a-zA-Z0-9_$]*\s*\(([^)]*)\)|(?:const|let)\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>)/);
    if (func_match) {
      const params_string = (func_match[1] ?? func_match[2] ?? '').trim();
      if (params_string.length > 0 && !params_string.includes('{')) {
        const param_count = params_string.split(',').filter(p => p.trim().length > 0).length;
        if (param_count > 3) {
          violations.push({
            file_path,
            line_number: line_index + 1,
            rule_id: 'MAX_FUNCTION_PARAMETERS',
            severity: 'MAJOR',
            message: `Function has ${param_count} parameters, exceeding the maximum allowed of 3. Encapsulate parameters into an object DTO.`,
            snippet: trimmed_line
          });
        }
      }
    }
  });

  // Check multiline function declarations
  const raw_str = String(content || '');
  const multiline_func_regex = /(?:function\s+[a-zA-Z0-9_$]*\s*\(([^)]*)\)|(?:const|let)\s+[a-zA-Z0-9_$]+\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>)/gs;
  let m_match;
  while ((m_match = multiline_func_regex.exec(raw_str)) !== null) {
    const params_string = (m_match[1] ?? m_match[2] ?? '').trim();
    if (params_string.includes('\n') && !params_string.includes('{')) {
      const param_count = params_string.split(',').map(p => p.replace(/\/\/.*$/mg, '').trim()).filter(Boolean).length;
      if (param_count > 3) {
        const line_number = raw_str.slice(0, m_match.index).split('\n').length;
        if (!violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS' && v.line_number === line_number)) {
          violations.push({
            file_path,
            line_number,
            rule_id: 'MAX_FUNCTION_PARAMETERS',
            severity: 'MAJOR',
            message: `Function has ${param_count} parameters, exceeding the maximum allowed of 3. Encapsulate parameters into an object DTO.`,
            snippet: m_match[0].split('\n')[0].trim()
          });
        }
      }
    }
  }

  // Rule 4: Boolean naming convention (prefix required for boolean variable assignments)
  lines.forEach((line, line_index) => {
    const trimmed_line = line.trim();
    if (trimmed_line.startsWith('//') || trimmed_line.startsWith('*')) {
      return;
    }
    // Match const/let varName = true / false;
    const bool_match = trimmed_line.match(/\b(?:const|let)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:true|false)\b/);
    if (bool_match) {
      const var_name = bool_match[1];
      const has_valid_prefix = ALLOWED_BOOLEAN_PREFIXES.some(prefix => var_name.startsWith(prefix)) ||
                               /^(?:is|has|can|should)[A-Z0-9]/.test(var_name);
      if (!has_valid_prefix) {
        violations.push({
          file_path,
          line_number: line_index + 1,
          rule_id: 'BOOLEAN_PREFIX_REQUIRED',
          severity: 'MINOR',
          message: `Boolean variable "${var_name}" should start with one of prefixes: ${ALLOWED_BOOLEAN_PREFIXES.join(', ')} or camelCase equivalent (isX, hasX, canX, shouldX)`,
          snippet: trimmed_line
        });
      }
    }
  });

  return {
    file_path,
    is_compliant: violations.length === 0,
    violations
  };
}

/**
 * Audits a set of files or directories against the coding standards policy.
 */
export function auditCodingStandards({ root_dir = process.cwd(), files = [], policy_path = DEFAULT_POLICY_PATH } = {}) {
  const policy = loadCodingStandardsPolicy(root_dir, policy_path);
  const all_violations = [];
  let total_files_checked = 0;

  for (const relative_file of files) {
    const absolute_file_path = path.resolve(root_dir, relative_file);
    if (!fs.existsSync(absolute_file_path)) {
      continue;
    }
    const stat = fs.statSync(absolute_file_path);
    if (stat.isDirectory()) {
      continue;
    }

    total_files_checked += 1;

    // Check filename convention
    const filename_check = checkFilenameConvention(relative_file);
    if (!filename_check.is_valid) {
      all_violations.push({
        file_path: relative_file,
        line_number: 1,
        rule_id: 'FILENAME_KEBAB_CASE',
        severity: 'MAJOR',
        message: `Filename "${filename_check.file_name}" should follow kebab-case naming convention.`,
        snippet: filename_check.file_name
      });
    }

    // Check file content
    const content = fs.readFileSync(absolute_file_path, 'utf8');
    const content_result = auditFileContent(relative_file, content, policy);
    if (!content_result.is_compliant) {
      all_violations.push(...content_result.violations);
    }
  }

  const blocking_count = all_violations.filter(v => v.severity === 'BLOCKING').length;
  const is_passed = blocking_count === 0;

  return {
    schema: 'agent-sdlc/coding-standards-report/v1',
    policy_schema: policy.schema,
    policy_version: policy.version,
    total_files_checked,
    violation_count: all_violations.length,
    blocking_violations: blocking_count,
    violations: all_violations,
    status: is_passed ? 'PASS' : 'FAIL'
  };
}
