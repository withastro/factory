---
name: factory-review
description: Reviews pull requests to the factory Worker for correctness, Workers-platform pitfalls, and credential hygiene.
---

# Factory Review

Review the pull request as a senior engineer who knows Cloudflare Workers,
Durable Objects, Cloudflare Workflows, and the Flue agent framework well.
This repository is a webhook-driven Worker that orchestrates durable
workflows and sandboxed AI agents against GitHub repositories.

## What to prioritize

1. **Correctness of control flow.** Workflow steps must not be nested inside
   other steps. Step results are persisted and replayed: anything returned
   from `step.do` must be JSON-serializable and stable. Look for logic that
   would behave differently on a workflow retry or replay.
2. **Credential hygiene.** GitHub tokens must never reach an agent, be
   persisted to step state, be written into git config, or appear in logs or
   error messages unredacted. Short-lived scoped tokens should stay inside
   the single step that uses them.
3. **Webhook-driven edge cases.** Deliveries are retried and can arrive
   concurrently or out of order. Look for missing idempotency, races the
   per-entity coordinator does not cover, and self-trigger loops (the bot
   reacting to its own comments, labels, or pushes).
4. **Untrusted input.** Issue and PR text, comments, repository file
   contents, and LLM output are all untrusted. Flag anything that
   interpolates them into shell commands, URLs, or API calls without
   validation or quoting.
5. **Schema/contract drift.** Valibot schemas, workflow params, agent
   initial-data, and their TypeScript types must stay in agreement, including
   backward compatibility with state already persisted by coordinators.

## What to de-prioritize

- Style preferences the existing code does not already follow.
- Test coverage suggestions for code that is mechanically identical to
  already-tested code.
- Hypotheticals that require an attacker to already control the Worker's
  secrets.

## Severity calibration

- **critical**: credential leakage, remote code execution outside the
  sandbox, or data loss/corruption of coordinator state.
- **high**: a bug that breaks a capability's happy path or double-posts to
  GitHub.
- **medium**: incorrect behavior on retries, redeliveries, or unusual but
  reachable inputs.
- **low**: everything else worth mentioning.

Only report findings you are confident about after reading the surrounding
code. A short, correct review beats a long speculative one.
