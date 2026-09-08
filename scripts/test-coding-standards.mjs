#!/usr/bin/env node
// Test suite for Deterministic Coding Standards & Clean Code Linter.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  loadCodingStandardsPolicy,
  checkFilenameConvention,
  auditFileContent,
  auditCodingStandards
} from '../runtime/coding-standards-linter.mjs';
import {createSuite} from './lib/suite.mjs';
import fs from 'node:fs';

// Fixtures live in data, not here. They are code samples that must contain the
// constructs the linter forbids -- 'var', ': any', 'as any' -- and inline they
// were source text in a lintable file, so the deterministic standards audit
// that gates every task read this suite's own test data as 16 BLOCKING
// violations. The file became uneditable: any task touching it failed a gate on
// strings whose whole purpose is to prove that gate works.
const CASES = JSON.parse(fs.readFileSync(
  new URL('./fixtures/coding-standards-cases.json', import.meta.url), 'utf8')).cases;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {test, assert, finish} = createSuite(
  'agent-sdlc/coding-standards-validation/v1',
  'CODING-STANDARDS-VALIDATION.json'
);

await test('coding-standards-policy-loads-and-valid', () => {
  const policy = loadCodingStandardsPolicy(ROOT);
  assert(policy.schema === 'agent-sdlc/coding-standards-policy/v1', 'schema should match expected version');
  assert(policy.naming_conventions !== undefined, 'naming_conventions must be defined');
  assert(policy.naming_conventions.variables_and_properties.style === 'snake_case', 'variables must be snake_case');
  assert(policy.clean_code_and_solid !== undefined, 'clean_code_and_solid must be defined');
  assert(policy.clean_code_and_solid.guidelines.max_function_parameters === 3, 'max parameters must be 3');
  assert(policy.domain_modeling_and_data_integrity !== undefined, 'domain_modeling_and_data_integrity must be defined');
  assert(typeof policy.domain_modeling_and_data_integrity.canonical_domain_values === 'string', 'canonical_domain_values must be defined');
  assert(typeof policy.domain_modeling_and_data_integrity.boundary_normalization === 'string', 'boundary_normalization must be defined');
  assert(policy.security_and_data !== undefined, 'security_and_data must be defined');
  assert(policy.performance_and_resources !== undefined, 'performance_and_resources must be defined');
  assert(policy.testing_and_typing !== undefined, 'testing_and_typing must be defined');
  assert(policy.requirements_clarification_and_planning !== undefined, 'requirements_clarification_and_planning must be defined');
  assert(typeof policy.requirements_clarification_and_planning.input_clarification_gate === 'string', 'input_clarification_gate must be defined');
  assert(typeof policy.requirements_clarification_and_planning.mandatory_detailed_planning === 'string', 'mandatory_detailed_planning must be defined');
  assert(typeof policy.requirements_clarification_and_planning.logical_task_decomposition === 'string', 'logical_task_decomposition must be defined');
});

await test('linter-detects-var-declaration', () => {
  const code = CASES.var_declaration;
  const res = auditFileContent('test-module.js', code);
  assert(res.is_compliant === false, 'should detect the obsolete declaration keyword');
  assert(res.violations.some(v => v.rule_id === 'NO_VAR_DECLARATION'), 'missing NO_VAR_DECLARATION rule');
});

await test('linter-detects-any-type', () => {
  const code_ts = CASES.any_in_typescript;
  const res_ts = auditFileContent('test-types.ts', code_ts);
  assert(res_ts.is_compliant === false, 'should detect any type in TS');
  assert(res_ts.violations.some(v => v.rule_id === 'NO_ANY_TYPE'), 'missing NO_ANY_TYPE in TS');

  const code_jsdoc = CASES.any_in_jsdoc;
  const res_jsdoc = auditFileContent('test-doc.js', code_jsdoc);
  assert(res_jsdoc.is_compliant === false, 'should detect any type in JSDoc');
  assert(res_jsdoc.violations.some(v => v.rule_id === 'NO_ANY_TYPE'), 'missing NO_ANY_TYPE in JSDoc');
});

await test('linter-does-not-read-prose-in-a-block-comment-as-a-type', () => {
  // A JSDoc body is prose. This exact sentence, from runtime/ci-evidence.mjs,
  // was reported as a BLOCKING strict-typing violation because `/:\s*any\b/`
  // matches "summary: any failing" -- and since the audit is merged into the
  // code-quality gate, it failed the task of anyone who touched that file.
  const flags = (name, file) =>
    auditFileContent(file, CASES[name]).violations.some(v => v.rule_id === 'NO_ANY_TYPE');

  // Prose in a comment body is not a type annotation. The fixture is the real
  // sentence from runtime/ci-evidence.mjs.
  assert(!flags('block_comment_prose', 'ci-evidence.mjs'), 'block-comment prose was read as a type annotation');
  for (const oneLiner of ['one_line_jsdoc_prose', 'one_line_block_prose'])
    assert(!flags(oneLiner, 'one-liner.mjs'), `prose in a single-line block comment was read as a type: ${oneLiner}`);

  // The annotation form inside a comment IS still caught -- that is the case
  // the rule exists for, and skipping comment bodies outright would lose it.
  assert(flags('jsdoc_annotation_in_comment', 'annotated.js'), 'a JSDoc @param {any} annotation is no longer detected');
  assert(flags('one_line_jsdoc_annotation', 'one-liner.js'), 'an annotation in a single-line block comment is no longer detected');

  // Real code is unaffected by the carve-out.
  assert(flags('real_any_annotation', 'real.ts'), 'a real type annotation in code is no longer detected');
  assert(flags('real_as_any_cast', 'real.ts'), 'a real type cast in code is no longer detected');

  // A generator method also begins with `*`, and it is CODE. Keying the
  // carve-out on a bare leading `*` turned a false positive on prose into a
  // false negative on real TypeScript -- the worse trade, because a rule that
  // silently stops firing is indistinguishable from code that passes.
  assert(flags('generator_method_in_class', 'gen.ts'), 'a generator method was mistaken for a comment body');

  // An inline comment must not shelter the code after it. This is the shape of
  // a pragma prefix, so it is the realistic way a violation would hide behind
  // an opening delimiter.
  assert(flags('inline_comment_then_violation', 'pragma.ts'), 'a violation after an inline block comment was sheltered by the opener');
  assert(flags('pragma_comment_then_violation', 'pragma.ts'), 'a violation after a pragma comment was sheltered by the opener');
});

await test('linter-detects-excessive-parameters', () => {
  const bad_code = CASES.excessive_parameters;
  const bad_res = auditFileContent('mailer.js', bad_code);
  assert(bad_res.is_compliant === false, 'should detect > 3 parameters');
  assert(bad_res.violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS'), 'missing MAX_FUNCTION_PARAMETERS');

  const multiline_bad = 'function sendEmail(\n  recipient,\n  subject,\n  body,\n  attachment,\n  priority\n) {}';
  const multiline_res = auditFileContent('mailer.js', multiline_bad);
  assert(multiline_res.is_compliant === false, 'should detect multiline > 3 parameters');
  assert(multiline_res.violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS'), 'missing multiline MAX_FUNCTION_PARAMETERS');

  const good_code = 'function sendEmail({ recipient, subject, body, attachment }) {}';
  const good_res = auditFileContent('mailer.js', good_code);
  assert(!good_res.violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS'), 'object parameter should be allowed');
});

await test('linter-detects-boolean-naming-violation', () => {
  const bad_code = 'const active = true;\nlet enabled = false;';
  const bad_res = auditFileContent('flags.js', bad_code);
  assert(bad_res.violations.some(v => v.rule_id === 'BOOLEAN_PREFIX_REQUIRED'), 'should flag missing boolean prefix');

  const good_snake = 'const is_active = true;\nlet has_permission = false;';
  const good_snake_res = auditFileContent('flags.js', good_snake);
  assert(!good_snake_res.violations.some(v => v.rule_id === 'BOOLEAN_PREFIX_REQUIRED'), 'valid snake_case prefixes should pass');

  const good_camel = 'const isActive = true;\nlet hasPermission = false;\nconst canSubmit = true;\nlet shouldRetry = false;';
  const good_camel_res = auditFileContent('flags.js', good_camel);
  assert(!good_camel_res.violations.some(v => v.rule_id === 'BOOLEAN_PREFIX_REQUIRED'), 'valid camelCase prefixes should pass');
});

await test('linter-detects-kebab-case-violation', () => {
  const bad_path = 'adapters/hooks/sessionStart.mjs';
  const bad_check = checkFilenameConvention(bad_path);
  assert(bad_check.is_valid === false, 'camelCase filename should be invalid');

  const good_path = 'adapters/hooks/claude-session-start.mjs';
  const good_check = checkFilenameConvention(good_path);
  assert(good_check.is_valid === true, 'kebab-case filename should be valid');
});

await test('plugin-core-files-audit', () => {
  const files_to_audit = [
    'runtime/coding-standards-linter.mjs',
    'policies/coding-standards.json'
  ];
  const report = auditCodingStandards({
    root_dir: ROOT,
    files: files_to_audit
  });
  assert(report.status === 'PASS', `Coding standards audit should PASS, got: ${JSON.stringify(report.violations)}`);
  assert(report.blocking_violations === 0, 'Zero blocking violations expected');
});

await finish();
