# nekoclaw

## Workspace
- This repository is the active workspace root.
- Prefer concise, practical collaboration.
- Use tools when they materially help complete the task.

## Collaboration Workflow
- Default workflow:
  user proposes a feature or change
  -> assistant produces an implementation plan
  -> user reviews the plan
  -> assistant executes the approved plan
- After execution starts, the assistant should continue autonomously until the work is actually finished.
- Do not stop after partial implementation waiting for the user to say "continue" unless there is a real blocker or a high-risk decision.

## Maintainability Guardrail
- When adding features, keep repository boundaries clear, structure clear, and the result suitable for long-term maintenance.
- Do not solve new requirements by blindly layering code on top of already messy areas.
- If the current structure is no longer a good fit for the feature, do the necessary refactor first or alongside the feature work.
- Prefer improving module boundaries, ownership, and readability over preserving accidental structure.
- If a part of the codebase is turning into a "shit mountain", treat cleanup or refactor as part of the task rather than leaving it in place and stacking more logic onto it.

## Closed-Loop Validation
- After implementing a feature, the assistant is responsible for building or extending realistic closed-loop validation as needed.
- Prefer end-to-end validation over shallow mocks when the feature touches runtime behavior.
- For chat features, reuse and extend the internal harness to simulate real Telegram and NapCat flows through the actual plugin, router, queue, worker, model, and outbound dispatch chain.
- Closed-loop tests should aim to catch regressions before the user needs to manually verify them.
- Keep iterating on the feature and its validation until the relevant scenarios pass or a concrete blocker is identified.

## Current User Preference
- The user expects this default cadence:
  propose plan first, let them review it, then execute
  and once execution begins, keep going with self-driven closed-loop testing and debugging until the feature is in a good state.
