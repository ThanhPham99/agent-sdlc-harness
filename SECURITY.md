# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.0.x   | :white_check_mark: |
| < 3.0   | :x:                |

## Reporting a Vulnerability

We take security seriously. If you discover a vulnerability or security issue within the Agent SDLC Harness, please report it privately:

1. **Email:** Report security issues via email to the repository maintainers or file a private security advisory on GitHub.
2. **Details:** Include a clear description of the vulnerability, reproduction steps, and potential impact.
3. **Response Time:** You will receive an initial response within 48 hours.

## Security Architecture & Invariants

The Agent SDLC Harness is built with defense-in-depth security principles:

1. **PreToolUse Guard:** A non-bypassable pre-invocation hook intercepting destructive filesystem and shell commands (`rm -rf /`, `Remove-Item -Recurse`, disk operations, raw block device modifications).
2. **Network & Execution Policy:** Network access is denied by default (`network_default: deny`); repository contents are treated as untrusted data (`repo_content_trust: untrusted-data`).
3. **Least Privilege & Secret Isolation:** Telemetry, replay manifests, and artifacts are sanitized to remove API keys, secrets, and environment tokens.
4. **Independent Review Boundary:** Security-critical workflows require independent reviewer contexts separate from the authoring agent.
