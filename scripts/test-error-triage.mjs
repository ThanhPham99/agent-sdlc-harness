#!/usr/bin/env node
// Test failure triage for various testing frameworks and compilers.
import {classifyFailureType,extractFailingNames,extractLocations,extractSummary,triageFailure} from '../runtime/triage.mjs';
import {createSuite} from './lib/suite.mjs';

const {test,assert,finish}=createSuite('agent-sdlc/error-triage-validation/v1','ERROR-TRIAGE-VALIDATION.json');

const JEST_OUTPUT=`
FAIL src/auth/login.spec.ts
  ● loginUser > invalid password should return 401

    AssertionError: expected 200 to equal 401
      at Object.<anonymous> (src/auth/login.spec.ts:42:15)
      at processTicksAndRejections (node:internal/process/task_queues:95:5)

  ✕ refreshToken > expired token should fail (25ms)

Test Suites: 1 failed, 1 total
Tests:       2 failed, 3 passed, 5 total
`;

const PYTEST_OUTPUT=`
=================================== FAILURES ===================================
___________________________ test_user_authentication ___________________________
def test_user_authentication():
>       assert authenticate("admin", "wrong") == True
E       AssertionError: assert False == True
tests/test_auth.py:28: AssertionError
FAILED tests/test_auth.py::test_user_authentication - AssertionError: assert False == True
=========================== 1 failed in 0.12s ===========================
`;

const GOTEST_OUTPUT=`
--- FAIL: TestProcessRefund (0.01s)
    refund_test.go:54: expected status COMPLETED, got PENDING
FAIL
FAIL	github.com/example/pkg/billing	0.034s
`;

const RUST_OUTPUT=`
running 2 tests
test auth::test_token_validation ... ok
test auth::test_expired_signature ... FAILED

failures:

---- auth::test_expired_signature stdout ----
thread 'auth::test_expired_signature' panicked at src/auth.rs:112:9:
assertion \`left == right\` failed
  left: 403
 right: 401

failures:
    auth::test_expired_signature

test result: FAILED. 1 passed; 1 failed; 0 ignored
`;

test('triages-jest-failure',()=>{
  const triage=triageFailure(JEST_OUTPUT,'test_targeted');
  assert(triage.failure_type==='ASSERTION_FAILURE',`type: ${triage.failure_type}`);
  assert(triage.failing_names.some(n=>n.includes('loginUser')||n.includes('refreshToken')),JSON.stringify(triage.failing_names));
  assert(triage.failing_locations.some(l=>l.includes('src/auth/login.spec.ts:42')),JSON.stringify(triage.failing_locations));
  assert(triage.summary.includes('AssertionError'),`summary: ${triage.summary}`);
});

test('triages-pytest-failure',()=>{
  const triage=triageFailure(PYTEST_OUTPUT,'test_full');
  assert(triage.failure_type==='ASSERTION_FAILURE',`type: ${triage.failure_type}`);
  assert(triage.failing_names.some(n=>n.includes('test_user_authentication')),JSON.stringify(triage.failing_names));
  assert(triage.failing_locations.some(l=>l.includes('tests/test_auth.py:28')),JSON.stringify(triage.failing_locations));
});

test('triages-go-test-failure',()=>{
  const triage=triageFailure(GOTEST_OUTPUT,'test_targeted');
  assert(triage.failing_names.includes('TestProcessRefund'),JSON.stringify(triage.failing_names));
  assert(triage.failing_locations.some(l=>l.includes('refund_test.go:54')),JSON.stringify(triage.failing_locations));
});

test('triages-cargo-test-failure',()=>{
  const triage=triageFailure(RUST_OUTPUT,'test_full');
  assert(triage.failing_names.includes('auth::test_expired_signature'),JSON.stringify(triage.failing_names));
  assert(triage.failing_locations.some(l=>l.includes('src/auth.rs:112')),JSON.stringify(triage.failing_locations));
});

test('triages-compilation-and-timeout-failures',()=>{
  assert(classifyFailureType('error[E0432]: unresolved import `foo::bar`')==='COMPILATION_ERROR');
  assert(classifyFailureType('TS2304: Cannot find name "missingSymbol".')==='COMPILATION_ERROR');
  assert(classifyFailureType('Timeout of 2000ms exceeded. For async tests and hooks, ensure "done()" is called.')==='TIMEOUT');
  assert(classifyFailureType('SyntaxError: Unexpected token , in JSON')==='SYNTAX_ERROR');
});

finish();
