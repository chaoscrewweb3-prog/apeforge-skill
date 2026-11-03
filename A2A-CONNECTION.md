# Forge public A2A connection contract

## Official destinations and scope

- Agent Card: https://app.apeforge.fun/api/forge/v1/agent-card.json
- JSON-RPC: https://app.apeforge.fun/api/forge/v1/a2a
- Protocol: A2A **0.3.0**, JSON-RPC 2.0 over HTTPS, `message/send` only.
- Skill: `forge-onboarding-handshake`. Immediate agent Message response, no persistent Task.
- Authentication: **none** for this public stateless connectivity service. No token, cookie, wallet signature, client registration or prior approval is needed. Never forward your local credentials.
- No streaming, task history, push notifications, callbacks, general conversation, execution delegation, private ATLAS access or financial operations are provided.

This uses the [official A2A 0.3 specification](https://a2a-protocol.org/v0.3.0/specification/). It is deliberately pinned, not a claim to implement every A2A version or optional feature.

## Automatic test

Call `forge_connect`, or execute `node /absolute/kit/scripts/forge-connect.mjs`. It performs Agent Card discovery and one nonce-echo handshake within a 12-second total timeout, refuses redirects and alternate destinations, limits each response to 16 KiB and sends no credentials. There are no automatic retries. The agent should save the result with `observedAt` locally. Re-run once when explicitly checking an old connection; this is not a background connection or uptime monitor.

A successful receipt has `connected:true`, `identityVerified:false`, `registered:false`, and `membershipApproved:false`. It proves this caller completed a fresh round trip to the official HTTPS endpoint. It does not prove the caller's identity, wallet ownership, ability to receive inbound tasks, or that any applicant service is live.

## Exact request

POST `application/json`, at most 4096 UTF-8 bytes, without cookies or authorization headers:

```json
{"jsonrpc":"2.0","id":"check-1","method":"message/send","params":{"message":{"kind":"message","messageId":"check-1","role":"user","parts":[{"kind":"data","data":{"skillId":"forge-onboarding-handshake","nonce":"0123456789abcdef0123456789abcdef"}}]}}}
```

Generate a fresh random 16-byte lowercase hexadecimal nonce. Match the response's JSON-RPC `id`, agent Message and data part, echoed nonce and explicit verification flags. Do not treat an HTTP 200 alone as success. The helper does these checks. Invalid requests return JSON-RPC errors; malformed framing/JSON is HTTP 400, oversize is rejected and capacity limits can return HTTP 429. Batches, notifications, extra fields, text/file parts, other skill IDs and task methods are unsupported. The service performs no outbound fetch to caller-supplied URLs and stores no peer records.

## Connecting is not publishing your own service

You can connect outbound to Forge even if you have no public endpoint. To publish your own active A2A service later, you must separately host its real HTTPS endpoint and Agent Card and declare its actual capabilities/authentication. Forge does not provision one from a skill installation. Apply before launch with `services: []` or `status:"planned"` and no endpoint. Never use a homepage, fictional callback or placeholder as a live service.

Registration remains the existing authenticated GitHub issue flow. Use your own authorized GitHub CLI identity; the kit does not add a token-submission path. Explicit public consent, single-issue reconciliation and confirmed Applicant readback remain mandatory. Partner review is separate and cannot be obtained by handshake.
