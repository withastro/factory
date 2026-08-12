# Astro Review

Astro Review is a GitHub App that runs repository-owned review instructions with
[Flue](https://flueframework.com/) and Cloudflare Workers AI. Adding a configured
label to a pull request starts a durable review and publishes validated findings
as a GitHub pull request review.

The initial release supports public repositories only. Events for private
repositories are acknowledged but ignored.

## How it works

1. GitHub sends a signed `pull_request.labeled` webhook.
2. A Durable Object keyed by repository and pull request starts one Workflow at
   a time and coalesces additional triggers into one pending review.
3. The Workflow loads `.github/astro-review.yml` or
   `.github/astro-review.yaml` and the configured skill from the pull request's
   immutable base SHA.
4. For a matching trigger, the Workflow removes the label, creates an
   `in_progress` GitHub Check Run, and starts a Flue agent with read-only GitHub
   tools and `@cf/moonshotai/kimi-k2.7-code` on Workers AI.
5. The Workflow validates every proposed inline location against GitHub's diff,
   verifies that the pull request is still open at the reviewed head SHA, and
   publishes a `COMMENT` review without requiring the label to remain present.
6. The Check Run is completed with a `success` conclusion. It currently reports
   Workflow activity only; findings and Workflow errors do not fail the check.

The model has no GitHub credentials or write tools. Only application code can
publish a review. A GitHub delivery ID is used for Workflow and publication
deduplication. While a review is active, re-adding the trigger label queues one
more review; subsequent triggers replace that pending review with the latest one.

## Requirements

- Node.js 22.19 or newer
- pnpm 10
- A Cloudflare account with Workers AI, Workflows, and Durable Objects access
- A GitHub App

## Deploy with Workers Builds

Connect this repository before creating the GitHub App so its webhook can use the
deployed Worker URL:

1. In the Cloudflare dashboard, open **Workers & Pages** and select
   **Create application**.
2. Select **Get started** next to **Import a repository**, connect the GitHub
   account, and select this repository.
3. Configure the project with these settings:

| Setting | Value |
| --- | --- |
| Worker name | `astro-review` |
| Production branch | `main` |
| Root directory | Leave blank (repository root) |
| Build command | `pnpm run build` |
| Deploy command | `pnpm exec wrangler deploy` |
| Non-production branch deploy command | `pnpm exec wrangler versions upload` |

The Worker name must match the `name` in `wrangler.jsonc`. Workers Builds installs
dependencies and creates its deployment API token automatically. Select **Save
and Deploy**, then record the generated `workers.dev` URL. Subsequent pushes to
`main` build and deploy automatically; other branches upload preview versions.

The health endpoint is available at `https://<worker-host>/health`.

## GitHub App

Create a GitHub App after the initial Worker deployment with these settings:

- Webhook URL: `https://<worker-host>/channels/github/webhook`
- Webhook content type: `application/json`
- Webhook secret: a new random secret
- Repository permission `Contents`: Read-only
- Repository permission `Checks`: Read and write
- Repository permission `Pull requests`: Read and write
- Subscribe to the `Pull request` event

When adding the Checks permission to an existing GitHub App, approve the new
permission for each existing installation before deploying this version.

Generate a private key and note the App ID. If the downloaded key begins with
`-----BEGIN RSA PRIVATE KEY-----`, convert it from PKCS#1 to unencrypted PKCS#8:

```sh
openssl pkcs8 -topk8 -nocrypt \
  -in github-app-private-key.pem \
  -out github-app-private-key.pkcs8.pem
```

The converted file must begin with `-----BEGIN PRIVATE KEY-----`. In the
Cloudflare dashboard, open the Worker's **Settings > Variables & Secrets** and
add these as encrypted runtime secrets:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

Prefer uploading the private key directly from the file to preserve its PEM
formatting and deploy the resulting secret version automatically:

```sh
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY \
  < github-app-private-key.pkcs8.pem
```

Build variables are not available to the running Worker, so do not add these under
Workers Builds settings. Install the GitHub App only on public repositories that
should be reviewed.

### Manual deployment

If Workers Builds is not used, install dependencies, authenticate Wrangler, add
the same secrets, and deploy from the repository root:

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm run deploy
```

For local development, copy the names and value format from `.dev.vars.example`
into `.dev.vars`, then run:

```sh
pnpm run dev
```

GitHub must be able to reach the local webhook URL, so use a tunnel when testing
live deliveries.

## Repository setup

Commit `.github/astro-review.yml` or `.github/astro-review.yaml` to the target
repository's base branch. If both exist, `.yml` takes precedence:

```yaml
version: 1
trigger:
  label: astro-review
review:
  skill: .agents/skills/astro-review
  severity: [critical, high, medium, low]
  areas:
    - design
    - correctness
    - security
    - runtime
    - completeness
    - error-handling
    - tests
    - maintainability
    - documentation
    - changeset
```

Create the configured skill at `.agents/skills/astro-review/SKILL.md`:

```md
---
name: astro-review
description: Review Astro pull requests for correctness and regressions.
---

# Review instructions

Inspect the changed files and report only actionable correctness, security, or
performance issues introduced by the pull request.
```

Skill directories must match `.agents/skills/<skill-name>`. A skill may contain
at most 32 UTF-8 text files and 256 KiB in total. Its frontmatter `name` must
match the directory name. `review.severity` and `review.areas` define the only
classification values the agent may submit. Both must be non-empty arrays of
unique names; omitting them uses the values shown above. The configuration is
the allowed vocabulary, while the skill defines how the agent should assess,
weight, and map findings to those values.

Configuration and skill files are always read from the pull request's base SHA,
not its unreviewed head. Changes to either file in a pull request therefore take
effect only after they reach the target branch.

## Triggering reviews

Add the exact configured label to an open pull request. The label must remain on
the pull request until publication, and the head commit must not change. To run
another review, remove and re-add the label.

The app publishes at most 20 inline comments per review. Duplicate locations,
locations absent from GitHub's available patch, and excess findings are retained
in the review body instead of being discarded. The application renders each
finding as `` `[severity][area]`: message ``. Skills control the finding content
and classification guidance, but cannot override this GitHub presentation format.

## Development

```sh
pnpm run check:types
pnpm test
pnpm run build
```

`pnpm run cf-typegen` refreshes `worker-configuration.d.ts` after changing
Cloudflare bindings. That generated file is intentionally ignored by Git.
