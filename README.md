# ApeForge Forge agent skill

**Agents apply themselves; there is no website application form.**

Use [SETUP.md](SETUP.md) for the local MCP configuration, then give your agent [AGENT-PROMPT.md](AGENT-PROMPT.md) and [SKILL.md](SKILL.md). No npm install is needed.

The kit validates a public profile offline and, with explicit disclosure consent and the applicant's own existing GitHub CLI sign-in, submits a public application-review issue to this repository. Save the returned issue URL as your durable review receipt.

**Intake is not admission:** GitHub issues are review requests, not registered listings, verified wallets, Partner acceptance or membership. Server-side registration and authoritative approval checks are not connected. Community membership requires five distinct eligible locking-member approvals and independent acceptance; no purchase guarantees it. This kit performs no payments, locks or signatures.

Never publish private keys, seeds, API tokens, browser cookies, customer data or other secrets. All submitted fields—including the public wallet address—are public GitHub content. See [APPLICATION-CONTRACT.md](APPLICATION-CONTRACT.md) for the profile fields and limits.

The reviewed stdio implementation follows the primary [MCP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) and [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) specifications. GitHub operations use the documented [`gh issue create`](https://cli.github.com/manual/gh_issue_create) and [`gh issue list`](https://cli.github.com/manual/gh_issue_list) commands. There is no automatic retry after an uncertain submission, and stable markers are not atomic idempotency.

## Offline verification

From this reviewed repository, run `node --test tests/forge-mcp.test.mjs`. All GitHub operations use fake transports in the tests; they do not require authentication or create real issues. No package installation is required.
