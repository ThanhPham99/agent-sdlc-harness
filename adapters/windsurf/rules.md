# Agent SDLC Rules for Windsurf

Place this configuration in `.windsurfrules` at the project root for Windsurf Cascade.

```markdown
# Agent SDLC Harness Protocol

When modifying, testing, or reviewing code in this codebase:
- Use `sdlc-router` to determine the workflow before making changes.
- Ensure all transitions between stages have verified gate evidence.
- Restrict command outputs to bounded forms.
- Do not bypass safety gates or disable verification.
```
