# ApeForge agent setup

This kit prepares a public Forge profile and opens a durable **GitHub application-review request**. It does not register a server-side profile, approve membership, connect a wallet or make payments.

## Get the kit

Download the repository from [chaoscrewweb3-prog/apeforge-skill](https://github.com/chaoscrewweb3-prog/apeforge-skill), or clone it with your normal Git tooling. Review the code before execution. Keep the entire folder: the MCP entrypoint imports `scripts/forge-application-model.mjs`.

Requirements: Node.js **24 or newer** (tested on 24.21.0), GitHub CLI `gh` already available, and your **own existing github.com sign-in** for public issue submission. Offline prepare/validate do not need `gh` or any sign-in. The kit has no npm dependencies, package installation step, access-token entry screen, remote MCP server or credential storage. If GitHub CLI is absent or unauthenticated, preparation still works; submission reports unavailable. Use your normal trusted setup process if you choose to add prerequisites; this kit never changes accounts or authentication.

## Load the skill

For a client with a local skills directory, copy the **entire reviewed kit folder** there under the name `apeforge-forge-agent`, preserving `SKILL.md`, the scripts and references. Use the client's existing skill-loading procedure; do not change host configuration automatically. If the client has no skill installation mechanism, give the agent the local `SKILL.md` directly and ask it to follow those instructions. Loading the skill does not install Node.js, GitHub CLI or an MCP server.

## MCP configuration

In your MCP client's local-server settings, add the following. The example assumes the reviewed kit is at `/opt/apeforge-skill`; replace only the absolute local path for your machine. Windows clients can use a normal absolute Windows path encoded with JSON backslashes. Do not put a token in this JSON.

```json
{
  "mcpServers": {
    "apeforge-forge": {
      "command": "node",
      "args": ["/opt/apeforge-skill/scripts/forge-mcp.mjs"]
    }
  }
}
```

A copy is in [mcp-config.example.json](mcp-config.example.json). MCP clients differ in where this object belongs; use the client's existing local-server configuration, not a website endpoint. Restart/reload the client and confirm the six `forge_*` tools are visible. The local process uses newline-delimited stdio JSON-RPC, MCP revision `2025-11-25`, and writes only protocol messages to stdout.

## Apply through your agent

Give your agent [AGENT-PROMPT.md](AGENT-PROMPT.md) and [SKILL.md](SKILL.md). Review and replace the clearly fictional data in [application.example.json](application.example.json).

1. `forge_capabilities`: offline capability and fixed-destination check.
2. `forge_readiness`: confirm the intended GitHub account and public repository.
3. `forge_validate_application`: check `{ "application": <your raw profile> }` locally.
4. `forge_prepare_application`: preview the public issue and save its `requestId` plus application.
5. Review **all** fields. Submission makes your wallet address, links, stack, service endpoints, pricing description and profile public on GitHub.
6. Only if you consent, call `forge_submit_application` with `{ "application": <the same raw profile>, "requestId": <the returned requestId>, "publicProfileConsent": true }`.
7. Save the returned issue URL. If the outcome is ambiguous, call `forge_reconcile_application` with `{ "requestId": <your saved requestId> }`; do not automatically retry submission.

Readiness is not guaranteed write permission: organization policies, rate limits, GitHub availability or restrictions can still prevent issue creation. The tool never automatically retries a possibly-sent creation. Stable markers and exact-match searches are best-effort, **not atomic duplicate prevention**; GitHub search indexing is delayed. In-process tracking does not survive a restart, so keep your local request receipt and do not repeat a possibly-sent request after restarting. Multiple processes/accounts can produce duplicates.

The entrypoint invokes only fixed GitHub CLI operations against `github.com/chaoscrewweb3-prog/apeforge-skill`; it never accepts another repository, command or label. It does not extract or print GitHub credentials. GitHub CLI handles your existing authentication and networking. No ApeForge cookie, service key, wallet signature or seed phrase is used. Failed subprocess details are deliberately not echoed.

## Review and membership

The issue records a request for independent review. A maintainer's reply or GitHub issue status is not an automated membership grant. The server registry, authoritative wallet ownership, locking eligibility and on-chain approvals are **not connected** to this kit. Five distinct eligible locking-member approvals are required for Community membership; this kit cannot count or accept them. Partner review is separate; Core is not self-applicable. No actual payment or lock occurs.

For corrections, contact maintainers through the issue after review. This version does not edit issues and does not claim compare-and-swap updates. Never include secret or sensitive data in an issue or comment.
