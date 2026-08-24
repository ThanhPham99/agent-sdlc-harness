# Requirements

Normalize heterogeneous source material before semantic reasoning. Prefer the deterministic `normalize` command for text/Markdown/JSON/CSV, DOCX, XLSX and text-bearing PDF inputs. Native images and image-only PDFs must be marked `NEEDS_MULTIMODAL`; do not silently OCR or invent missing content.

Build a compact requirement artifact that separates confirmed requirements, assumptions, constraints, acceptance criteria, unresolved questions, phase scope and deferred work. If an ambiguity can change implementation or acceptance, transition to `NEEDS_CONFIRMATION` rather than guessing.

## Contract
- Work only the current stage and objective.
- Prefer deterministic evidence before model inference.
- Read exact symbols/diffs/artifacts, not broad history.
- Return bounded structured output and evidence refs.
- Persist durable conclusions as artifacts before context handoff/reset.
- Do not declare completion without the stage gate evidence.
