# Agent SDLC Configuration for Cline & Roo Code

Apply this configuration to `.clinerules` or `.roomodes` at the root of your project to integrate with Agent SDLC Harness.

```markdown
# Agent SDLC Harness Protocol

For tasks modifying, inspecting, or operating on this repository:
1. Route the objective through `bin/agent-sdlc route --objective "<task>"` or the MCP tool `agent_sdlc_route`.
2. Follow the SDLC stage lifecycle: INTAKE -> SPEC -> PLAN -> DESIGN -> IMPL -> VERIFY -> REVIEW -> RELEASE -> DEPLOY -> OBSERVE -> CLOSE.
3. Keep task slices bounded: 1 bounded task ≈ 1 bounded context.
4. Provide concrete evidence for every gate transition (`bin/agent-sdlc transition --run-id <id> --to <stage> --evidence <token>`).
5. Never execute unverified destructive operations.
```
