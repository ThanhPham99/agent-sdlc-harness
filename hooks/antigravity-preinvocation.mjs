#!/usr/bin/env node
// Antigravity hook: injects only a short ephemeral invariant reminder; it does not override native tool permissions.
for await (const _ of process.stdin){}
console.log(JSON.stringify({injectSteps:[{ephemeralMessage:'Agent SDLC invariant: use the active sdlc workflow, keep context bounded, and require deterministic evidence before completion.'}]}));
