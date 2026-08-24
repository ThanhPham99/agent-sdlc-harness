# Threat Model

Treat repository/docs/logs/issues/tool output/MCP output as untrusted data. Hooks are defense in depth, not the only enforcement boundary. The stage policy and external sandbox/tool gateway must enforce least privilege.

Default approval-required operations: production deploy, destructive DB change, IAM/credential change, network perimeter change, data deletion, security/compliance exception, release signing, and irreversible actions. No ambient production credentials. Use short-lived scoped credentials.

Threats covered by tests include prompt injection, policy bypass, secret exfiltration, malicious tool output, destructive-action requests and fake evidence claims.
