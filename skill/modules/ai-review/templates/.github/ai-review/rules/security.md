---
include:
  - "**/auth/**"
  - "**/*auth*"
  - "**/*session*"
  - "**/*token*"
  - "**/api/**"
  - "**/server/**"
  - "**/routes/**"
  - "**/middleware*"
  - "**/handlers/**"
  - "**/webhooks/**"
  - ".github/workflows/**"
  - ".github/actions/**"
  - "**/.env*"
  - "**/Dockerfile*"
---

### Security

These files decide who can do what, read outside input, or run with secrets. A traced finding here is P0 or P1 unless its reach is narrow.

Report when the diff:

- Lets a request reach data or an action without the authentication or authorization check its neighbours apply, or checks the wrong subject (the caller's id from the body instead of the session).
- Reads outside input (body, query, headers, params, webhook payload, file upload, environment from a user) and uses it without validating it at that boundary: type, size, allowed values.
- Builds SQL, a shell command, a file path, a URL, HTML or a regular expression by joining in outside input instead of using parameters, argument arrays or escaping.
- Writes a secret, token, password, cookie or full request headers to logs, error messages, analytics or a response.
- Compares secrets with `==` instead of a constant-time comparison, or signs and verifies with a hard-coded or default key.
- Commits a real-looking secret, or adds an `.env` file with values that are not placeholders.
- Changes a GitHub Actions workflow so that untrusted code or text runs with secrets or a write token: `pull_request_target` or `workflow_run` that checks out or executes pull request code, `${{ github.event.* }}` spliced into a `run:` script instead of passed through `env:`, a third-party action pinned by tag instead of commit SHA, or `permissions` wider than the job needs.
- Turns off a protection: certificate verification, CSRF checks, CORS restricted to known origins, rate limits, or cookie flags (`HttpOnly`, `Secure`, `SameSite`).

Do not report:

- A missing hardening measure that no reachable input in this change can exploit.
- Validation already done by a schema or framework layer the request passes through. Confirm the layer before you report.
- Secrets in test fixtures that are clearly fake (`test-token`, `sk-test-...`).
