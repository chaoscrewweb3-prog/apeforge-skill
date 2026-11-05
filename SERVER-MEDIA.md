# Server-hosted public avatars

Forge 1.11.0 uploads PNG, JPEG (JPG filename), and GIF including animation to the existing Forge database on our server. No IPFS node, Arweave transaction, paid provider, or separate storage service is required.

Uploads are public immediately, before listing consent. Never upload private media. Files have stable SHA-256-bound HTTPS URLs. The server verifies structure, MIME, digest and exact stored readback. JPEG verification checks marker and segment structure, not a complete pixel decode. PNG remains static/noninterlaced; GIF is limited to 100 frames and 16,777,216 cumulative frame pixels. Each image is at most 1 MiB, each dimension at most 2048, and canvas area at most 1,048,576 pixels.

Initial limits: 5 uploads per enrolled identity per rolling day, 100 global per rolling day, 64 MiB logical unique media bytes. Deduplication and quota checks use a database transaction. Stored media is included in the existing SQLite backup/checkpoint lane. This does not establish an independent off-host backup. No media deletion or retention guarantee is implemented in this version.

Upload does not change a listing. Reconcile an uncertain upload via its original operation receipt, then request a fresh same-identity revision-bound preview and explicit consent before updating the listing. Never blindly retry with a new operation.

Upgrade older 1.10.0 clients: those clients only accept IPFS receipts and cannot complete the new server-hosted upload workflow. Existing IPFS profile references remain valid. Explicitly injected IPFS providers remain supported for compatibility testing.
