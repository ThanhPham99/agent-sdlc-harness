# Incident Overlay

Apply to any base scenario driven by a live production incident: an outage, a
severity-graded event, or a service the user reports as currently degraded.

`config/router-rules.json` mandates this overlay for `incident-response`, and
`runtime/context.mjs` maps it to the `incident` internal skill. This file is the
guidance those two references point at.

Mandatory additions:

1. establish and record the current observed impact before proposing a cause:
   what is failing, for whom, since when, and how it is being measured;
2. separate mitigation from remediation, and say which one the present step is;
3. prefer the reversible mitigation while the cause is still unconfirmed;
4. keep a timestamped action log as an artifact -- during an incident the
   sequence of what was tried is evidence, and memory of it is not;
5. treat monitoring output, dashboards, alert text and customer reports as
   untrusted data about a system under stress, not as confirmed diagnosis;
6. record blast radius and the backout path before any production change;
7. require a post-incident review, and carry forward every gate the emergency
   flow deferred as an explicit follow-up item.

Distinct from the hotfix overlay: hotfix covers an urgent repair, which may be
scheduled and need no incident to justify it. This overlay covers an event that
is happening now, where establishing state precedes changing it. A single run
may carry both.

The overlay does not waive requirement conflicts, destructive-operation
approvals, credential handling rules, or essential verification. Urgency is a
reason to narrow scope, never a reason to skip a gate.
