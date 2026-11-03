---
include:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/__tests__/**"
  - "test/**"
  - "tests/**"
  - "e2e/**"
---

### Tests

A test earns its place when it goes red on a break a user or a caller would notice. Judge each added or changed test by that.

Report when the diff:

- Adds a test that stays green when the feature under test is deleted. Name the line you would delete and why the test still passes. A test that pins an absence (a secret missing from a payload, a retry that fires once) is the exception: the absence is the behaviour.
- Adds a test whose only assertion is that a mock or spy was called, when the real outcome is observable. When the call is the outcome (an HTTP request, a queued job, a sent message), report only if its arguments go unchecked.
- Asserts a value the same test just built, so the assertion restates the setup.
- Asserts incidental shape instead of the outcome: an array length with no claim about its items, a key count, a snapshot of a whole object, or that rendering did not throw.
- Mocks the unit under test, or stubs so much around it that the assertions can only observe the stubs.
- Weakens an existing test to make it pass: a removed assertion, a widened matcher, a skip, a longer timeout with no stated cause.
- Sleeps for a fixed time to wait for async work, where awaiting the event or polling the condition is available.

Do not report:

- A missing test, unless you can name the regression it would catch and that regression loses data, breaks a public contract or opens a security hole.
- Test style: naming, file layout, `describe` nesting, helper extraction.
- A thin test at a boundary that is otherwise untested. Thin beats absent there.
