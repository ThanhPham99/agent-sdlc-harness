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
  assert(policy.security_and_data !== undefined, 'security_and_data must be defined');
  assert(policy.performance_and_resources !== undefined, 'performance_and_resources must be defined');
  assert(policy.testing_and_typing !== undefined, 'testing_and_typing must be defined');
});

await test('linter-detects-var-declaration', () => {
  const code = 'var obsolete_variable = 10;';
  const res = auditFileContent('test-module.js', code);
  assert(res.is_compliant === false, 'should detect var declaration');
  assert(res.violations.some(v => v.rule_id === 'NO_VAR_DECLARATION'), 'missing NO_VAR_DECLARATION rule');
});

await test('linter-detects-any-type', () => {
  const code_ts = 'function processData(payload: any): void {}';
  const res_ts = auditFileContent('test-types.ts', code_ts);
  assert(res_ts.is_compliant === false, 'should detect any type in TS');
  assert(res_ts.violations.some(v => v.rule_id === 'NO_ANY_TYPE'), 'missing NO_ANY_TYPE in TS');

  const code_jsdoc = '/** @type {any} */\nconst untyped = JSON.parse("{}");';
  const res_jsdoc = auditFileContent('test-doc.js', code_jsdoc);
  assert(res_jsdoc.is_compliant === false, 'should detect any type in JSDoc');
  assert(res_jsdoc.violations.some(v => v.rule_id === 'NO_ANY_TYPE'), 'missing NO_ANY_TYPE in JSDoc');
});

await test('linter-detects-excessive-parameters', () => {
  const bad_code = 'function sendEmail(recipient, subject, body, attachment, priority) {}';
  const bad_res = auditFileContent('mailer.js', bad_code);
  assert(bad_res.is_compliant === false, 'should detect > 3 parameters');
  assert(bad_res.violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS'), 'missing MAX_FUNCTION_PARAMETERS');

  const good_code = 'function sendEmail({ recipient, subject, body, attachment }) {}';
  const good_res = auditFileContent('mailer.js', good_code);
  assert(!good_res.violations.some(v => v.rule_id === 'MAX_FUNCTION_PARAMETERS'), 'object parameter should be allowed');
});

await test('linter-detects-boolean-naming-violation', () => {
  const bad_code = 'const active = true;\nlet enabled = false;';
  const bad_res = auditFileContent('flags.js', bad_code);
  assert(bad_res.violations.some(v => v.rule_id === 'BOOLEAN_PREFIX_REQUIRED'), 'should flag missing boolean prefix');

  const good_code = 'const is_active = true;\nlet has_permission = false;';
  const good_res = auditFileContent('flags.js', good_code);
  assert(!good_res.violations.some(v => v.rule_id === 'BOOLEAN_PREFIX_REQUIRED'), 'valid prefixes should pass');
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
