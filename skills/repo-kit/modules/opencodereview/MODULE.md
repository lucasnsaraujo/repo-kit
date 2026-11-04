# opencodereview

The alternative to `ai-review` for an owner who runs a server. [OpenCodeReview](https://github.com/BridgLabs/opencodereview) is a self-hosted reviewer: a Docker Compose app that watches the repositories you pick, reviews each pull request with Claude Code or Codex on your own subscription, and posts the result. Nothing runs in this repository's CI. The kit only writes the file that tells the reviewer what matters here.

Pick it when the owner has, or will set up, a machine that stays on (a VPS, a home server) with Docker. Otherwise use `ai-review`. The two cannot be selected together, and `agent-loops` needs `ai-review` (its `babysit` skill reads that module's comment and status), so `agent-loops` is left out with this module.

## Sets up

- `REVIEW.md`: repository review rules. OpenCodeReview reads `REVIEW.md`, `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` and `README.md` from the pull request's base commit, so the rules take effect once this file is on the default branch, and a pull request cannot rewrite them.
- What the server does, for the owner's reference (none of it is configured here):
  - polls GitHub every 5 minutes through the `gh` CLI and reviews each new pull request and each new push (only what changed since the last review);
  - runs the AI in locked-down runner containers with a read-only snapshot of the code and network access only to the AI provider;
  - posts a summary comment it updates on each push, and the findings as one non-blocking review with inline comments, from the GitHub account the owner signed in with. It never approves;
  - drops any finding whose quoted code does not match the snapshot exactly, and never calls such a review clean;
  - the pull request's author, when an owner, member or collaborator of the repository, can ask for a review by commenting exactly `/ocr review`.
- No commit status: the review cannot be a required check, so the `ci` module's branch protection does not list it.

## Tailor

1. Fill every `<!-- fill: ... -->` in `REVIEW.md` from this repository: the checks CI runs (read `.github/workflows/` and `package.json` scripts), then 1 to 3 of the riskiest areas, where a bug loses data, leaks access, takes money or breaks a released contract (auth, billing, migrations, public API, queues, deploy config). Give each area its own `##` heading, one line on the cost of a bug, and a `Report a change that:` list naming real files, functions or invariants. End with the false positives this code invites under `## Leave out`. Done when `grep -n "<!-- fill:" REVIEW.md` prints nothing and every area names at least one path that `git ls-files` lists.
2. When `REVIEW.md.repo-kit-new` exists, merge the kit's sections into the existing file, keeping the project's rules. Done when no `REVIEW.md.repo-kit-new` remains.

## Owner steps

1. **License.** OpenCodeReview is licensed under PolyForm Small Business 1.0.0: free for individuals, non-profits, and companies under 100 people and USD 1M revenue in the prior year. Larger companies need a commercial license from BRIDG LABS (contato@bridglabs.com). Confirm which applies before installing.

2. **Run it on the server.** It needs Docker Engine with Compose v2.24.4 or newer. The override keeps the UI on the server's loopback: Compose publishes port 1421 on every interface otherwise, past host firewalls such as ufw, and anyone who opens the UI controls the install.

   ```sh
   git clone https://github.com/BridgLabs/opencodereview && cd opencodereview
   cat > compose.override.yml <<'YAML'
   services:
     web:
       ports: !override
         - "127.0.0.1:1421:1421"
   YAML
   docker compose -f docker-compose.yml -f docker-compose.images.yml -f compose.override.yml up -d
   ```

   `OCR_VERSION=0.2.0` before `docker compose` pins a release; the default follows the newest.

3. **Onboard.** From your machine, tunnel to the UI and open `http://localhost:1421`:

   ```sh
   ssh -N -L 1421:127.0.0.1:1421 <server>
   ```

   Sign in to GitHub with an account that can comment on this repository (the reviews are posted as that account), connect a Claude plan (`claude setup-token`, paste the code back) or a ChatGPT plan (`codex login`), and select this repository. Reviews count against that plan's usage limits on every push to every open pull request.

## Verify

- `grep -n "<!-- fill:" REVIEW.md` prints nothing.
- After `REVIEW.md` is on the default branch and the owner steps are done, open a pull request. Within about 5 minutes plus the review time, this prints a comment URL:

  ```sh
  gh api "repos/{owner}/{repo}/issues/<number>/comments" \
    --jq '.[] | select(.body | contains("<!-- ocr-pr-summary:v1")) | .html_url'
  ```

  The review's inline comments carry `<!-- ocr-review-post:v1`; a clean result is a comment headed `OpenCodeReview found no issues`.

## Prior art

- **OpenCodeReview** `README.md`, `REVIEW.md` and `backend/src/review/git.rs` (`CONVENTION_FILES`): the convention files it reads from the base commit, and the shape of a review rules file: report lists per risky area, then what to leave out. The template is written for this kit; no text is copied (OpenCodeReview is not MIT-licensed).
- **Docker Compose** merge docs: `!override` replaces the `web` service's port list instead of appending to it, which is what keeps the UI off public interfaces.
