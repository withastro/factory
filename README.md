# Factory

A software factory: one Cloudflare Worker that receives GitHub webhooks and
routes them through a deterministic dispatcher to durable
[Flue](https://flueframework.com/) agents. Each capability (triage, review,
and more to come) is a folder of workflows, coordinators, and agents; adding a
capability means adding a folder and a routing rule.

Built by combining [withastro/astro-review](https://github.com/withastro/astro-review)
(absorbed nearly as-is — it already had this architecture) and
[withastro/triagebot-action](https://github.com/withastro/triagebot-action)
(ported from GitHub Actions to Workers).

## Architecture

```
GitHub webhooks ─→ Hono ingress (signature verification)
                    └→ router.ts (pure rule table: event → capability dispatch)
                        ├→ ReviewCoordinator DO (one per PR)  ─→ ReviewWorkflow ─→ PullRequestReviewer agent
                        └→ TriageCoordinator DO (one per issue) ─→ TriageWorkflow ─→ FixVerifier / RetriageJudge agents
```

- **Router** (`src/router.ts`): deterministic and pure. `pull_request.labeled`
  → review; `issues.opened|reopened|closed` and human `issue_comment.created`
  → triage. Bot comments and private repositories are dropped at the door.
- **Coordinators** (`src/coordination/queue-coordinator.ts`): a Durable Object
  per entity serializes work — one active workflow, one pending (newest wins),
  delivery-id dedupe, and a reconcile alarm for self-healing. This replaces
  GitHub Actions' `concurrency` groups.
- **Workflows**: every side effect is a checkpointed, retried step. The triage
  workflow re-reads issue labels when it runs and routes through the FSM
  (`src/triage/fsm.ts`), so queued events always act on fresh state.
- **Agents**: Flue agents on Workers AI (Kimi) via the `AI` binding — no model
  API keys. The reviewer gets read-only GitHub tools; the triage classifiers
  get no tools at all, only the conversation text. Only trusted workflow code
  writes to GitHub.

## Capabilities

### Review (`src/review/`)

Adding the configured trigger label to a pull request runs the
repository-owned review skill and publishes validated findings as a PR review
(inline comments anchored against the real diff, the rest in the body, always
with an LLM disclosure). Config and skill are read at the target branch's tip
SHA captured at webhook time — never from the PR head.

### Triage (`src/triage/`)

A label-driven state machine over issues, with all state living in GitHub
labels (visible, maintainer-overridable):

- Issue opened/reopened → the full pipeline (reproduce → diagnose → verify →
  fix) runs in a **Cloudflare Sandbox container** holding a real checkout of
  the repository: a hardened blobless clone of the default branch, a
  `factory/fix-N` branch, the skill seeded into the workspace, and a shell
  for building and testing. The workflow then commits and force-pushes any
  changes (the contents-scoped token exists only inside that one step and
  never reaches the agent), optionally opens a PR (`autoPrOnFix`), generates
  the triage comment from the pipeline's `report.md`, applies the resolved
  state label, and selects priority/package labels.
- Comment on `triage: fix pending` → the FixVerifier agent classifies the
  reporter's response: confirmed → open the fix PR + `fix verified`;
  rejected → `fix rejected`.
- Comment on a re-triageable label → the RetriageJudge agent decides whether
  new actionable information warrants a re-run.
- Issue closed → the fix branch is deleted.
- Unexpected failures post a marked comment; three strikes parks the issue in
  `triage: failed` until a maintainer clears it.

Missing labels are created automatically with sensible colors, so installing
on a fresh repository requires no setup.

## Repository configuration

Target repositories may add `.github/factory.yml` (all sections optional; no
file at all means triage-on with defaults and review off). Configuration is
always read from maintainer-controlled content.

```yaml
version: 1

review:
  trigger:
    label: ai-review
  skill: .agents/skills/astro-review   # repository-owned, required for review
  # severity: [critical, high, medium, low]
  # areas: [correctness, security, ...]

triage:
  # enabled: true
  # autoPrOnFix: false
  # skill: .agents/skills/triage       # overrides the bundled default skill
  # labels:
  #   fixPending: awaiting-confirmation
```

Skills resolve as **bundled default, repository override wins**: the factory
ships a generic triage skill (`skills/triage/`); a repository can replace it
by committing `.agents/skills/triage/` and pointing `triage.skill` at it.
(The bundled entry file is stored as `skill.md` — Flue's vite plugin treats
imports literally named `SKILL.md` as packaged skills, and we need the raw
text; it's seeded into the sandbox as `SKILL.md`.)

## GitHub App setup

- **Permissions**: Contents (read/write), Issues (read/write), Pull requests
  (read/write), Checks (read/write).
- **Events**: Pull request, Issues, Issue comment. (Workflow run will be added
  for preview releases.)
- **Webhook URL**: `https://<worker>/channels/github/webhook`.
- **Secrets** (`wrangler secret put` / `.dev.vars`): `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY` (PKCS#8 — convert with
  `openssl pkcs8 -topk8 -nocrypt`), `GITHUB_WEBHOOK_SECRET`.

Public repositories only for now; private-repository deliveries are
acknowledged and ignored.

## Development

```sh
pnpm install
pnpm dev          # local dev (vite + workerd); triage sandboxes need Docker running
pnpm test         # vitest
pnpm check:types  # tsc
pnpm deploy       # vite build && wrangler deploy
```

`vite build` is mandatory before deploy: the Flue vite plugin compiles each
`'use agent'` module into a Durable Object class and generates the merged
wrangler config. Never hand-author `FLUE_*` bindings; do declare migrations
for generated classes (see `wrangler.jsonc`).

## Roadmap

1. **Preview releases** — a repo-side `workflow_dispatch` Action the factory
   triggers after pushing a fix branch (`pkg-pr-new` needs Actions OIDC);
   results return via `workflow_run` webhooks. Until then, `fix pending` is
   reached only via preview releases, so fixes either open a PR directly
   (`autoPrOnFix`) or land as a pushed branch + `needs triage`.
2. **PR feedback agent** — respond to maintainer reviews with code changes.
3. **Pluggable routing** — the router is a pure `event → dispatch` function
   precisely so a markdown-configured LLM router can slot in later.
