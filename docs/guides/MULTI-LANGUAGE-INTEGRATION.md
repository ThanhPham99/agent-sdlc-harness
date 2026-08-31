# Multi-Language Integration Guide

Agent SDLC Harness is language-agnostic. While the harness runtime itself runs on Node.js without third-party dependencies, it can govern and execute projects written in any language or technology stack.

---

## 1. Project Configuration Structure

Your repository declares its build and test commands in `.agent-sdlc/project.json`:

```json
{
  "schema": "agent-sdlc/project/v1",
  "project": "my-service",
  "type": "standard",
  "languages": ["python"],
  "test_commands": {
    "test_targeted": ["pytest", "-q", "{selector}"],
    "test_full": ["pytest", "-v"],
    "typecheck": ["mypy", "src/"]
  },
  "build_commands": {
    "build": ["python", "-m", "build"]
  }
}
```

---

## 2. Language-Specific Templates

### JavaScript / TypeScript (Jest / Vitest / Node Test Runner)
```json
{
  "test_commands": {
    "test_targeted": ["npm", "test", "--", "{selector}"],
    "test_full": ["npm", "test"],
    "typecheck": ["npm", "run", "typecheck"]
  },
  "build_commands": {
    "build": ["npm", "run", "build"]
  }
}
```

### Python (pytest / unittest / mypy / ruff)
```json
{
  "test_commands": {
    "test_targeted": ["pytest", "-q", "{selector}"],
    "test_full": ["pytest", "--maxfail=1"],
    "typecheck": ["mypy", "src/"],
    "lint": ["ruff", "check", "."]
  },
  "build_commands": {
    "build": ["pip", "install", "-e", "."]
  }
}
```

### Go (go test / golangci-lint)
```json
{
  "test_commands": {
    "test_targeted": ["go", "test", "-run", "{selector}", "./..."],
    "test_full": ["go", "test", "-race", "./..."],
    "lint": ["golangci-lint", "run"]
  },
  "build_commands": {
    "build": ["go", "build", "-v", "./..."]
  }
}
```

### Rust (cargo test / clippy)
```json
{
  "test_commands": {
    "test_targeted": ["cargo", "test", "--test", "{selector}"],
    "test_full": ["cargo", "test", "--all"],
    "lint": ["cargo", "clippy", "--", "-D", "warnings"]
  },
  "build_commands": {
    "build": ["cargo", "build", "--release"]
  }
}
```

### Java / Kotlin (Maven / Gradle)
```json
{
  "test_commands": {
    "test_targeted": ["mvn", "test", "-Dtest={selector}"],
    "test_full": ["mvn", "clean", "test"]
  },
  "build_commands": {
    "build": ["mvn", "package", "-DskipTests"]
  }
}
```

---

## 3. Dynamic Selector Substitution

When executing tasks with `verifyTask`, `{selector}` is dynamically substituted with the targeted test file or function name declared in the task's `verification.targeted_tests`.

If no targeted test is specified, `{selector}` defaults to empty or the task fails closed to prevent executing unbounded commands uninspected.

