# Astro Review

Astro Review is a GitHub App that runs repository-owned review instructions with
[Flue](https://flueframework.com/) and Cloudflare Workers AI. Adding a configured
label to a pull request starts a durable review and publishes validated findings
as a GitHub pull request review.

The initial release supports public repositories only. Events for private
repositories are acknowledged but ignored.

## How it works

1. GitHub sends a signed `pull_request.labeled` webhook.
2. A Cloudflare Workflow loads `.github/astro-review.yml` and the configured skill
   from the pull request's immutable base SHA.
3. A Flue agent reviews the change with read-only GitHub tools and
   `@cf/moonshotai/kimi-k2.6` on Workers AI.
4. The Workflow validates every proposed inline location against GitHub's diff,
   verifies that the head SHA and trigger label are unchanged, and publishes a
   `COMMENT` review.

The model has no GitHub credentials or write tools. Only application code can
publish a review. A GitHub delivery ID is used for Workflow and publication
deduplication.

## Requirements

- Node.js 22.19 or newer
- pnpm 10
- A Cloudflare account with Workers AI and Workflows access
- A GitHub App

## GitHub App

Create a GitHub App with these settings:

- Webhook URL: `https://<worker-host>/channels/github/webhook`
- Webhook content type: `application/json`
- Webhook secret: a new random secret
- Repository permission `Contents`: Read-only
- Repository permission `Pull requests`: Read and write
- Subscribe to the `Pull request` event

Generate a private key and note the App ID. Install the app only on public
repositories that should be reviewed.

## Deploy

Install dependencies and authenticate Wrangler:

```sh
pnpm install
pnpm exec wrangler login
```

Store the GitHub App credentials as encrypted Worker secrets:

```sh
pnpm exec wrangler secret put GITHUB_APP_ID
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
```

Deploy the Worker:

```sh
pnpm run deploy
```

Set the deployed `/channels/github/webhook` URL on the GitHub App. The health
endpoint is available at `/health`.

For local development, copy the names and value format from `.dev.vars.example`
into `.dev.vars`, then run:

```sh
pnpm run dev
```

GitHub must be able to reach the local webhook URL, so use a tunnel when testing
live deliveries.

## Repository setup

Commit `.github/astro-review.yml` to the target repository's base branch:

```yaml
version: 1
trigger:
  label: astro-review
review:
  skill: .agents/skills/astro-review
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
match the directory name.

Configuration and skill files are always read from the pull request's base SHA,
not its unreviewed head. Changes to either file in a pull request therefore take
effect only after they reach the target branch.

## Triggering reviews

Add the exact configured label to an open pull request. The label must remain on
the pull request until publication, and the head commit must not change. To run
another review, remove and re-add the label.

The app publishes at most 20 inline comments per review. Duplicate locations,
locations absent from GitHub's available patch, and excess findings are retained
in the review body instead of being discarded.

## Development

```sh
pnpm run check:types
pnpm test
pnpm run build
```

`pnpm run cf-typegen` refreshes `worker-configuration.d.ts` after changing
Cloudflare bindings. That generated file is intentionally ignored by Git.
