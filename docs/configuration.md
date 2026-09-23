# Configuration and key management

## Configuration

The following defaults are compiled fallbacks. `.env.example` overrides several values for local demonstration.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Gateway process port; Compose maps port 3000 |
| `ENCRYPT_RESPONSE` | `true` | `true`: encrypt response; `false`: standard JSON |
| `RSA_PRIVATE_KEY` | Empty | PEM or base64-encoded PEM; multiple keys comma-separated |
| `RSA_PRIVATE_KEY_PATH` | Empty | Path to private key file; multiple paths comma-separated |
| `AUTO_GENERATE_KEYS` | Active outside tests | Set `false` to reject startup if no key exists |
| `ALLOWED_ROUTES` | Empty | `[METHOD] host/path`, comma-separated; wildcards allowed at path end only |
| `ALLOWED_TARGET_HOSTS` | Empty | Authorizes all paths and methods for specified hosts |
| `ALLOW_HTTP_UPSTREAM` | `false` | HTTP upstream permitted strictly for local dev when `true` |
| `TRUST_PROXY` | Unset | IP/subnet or hop count for trusted reverse proxy |
| `MAX_BODY_SIZE` | `1mb` | Maximum outer JSON request size including base64 overhead |
| `MAX_UPSTREAM_RESPONSE_BYTES` | `5242880` | Upstream response decompressed size limit (5 MiB) |
| `UPSTREAM_TIMEOUT_MS` | `15000` | Backend upstream timeout in milliseconds |
| `CORS_ORIGINS` | Empty | Permitted browser origins, comma-separated |
| `THROTTLE_TTL_MS` | `60000` | Rate limit fixed window (ms) |
| `THROTTLE_LIMIT` | `60` | Maximum requests per client IP within the window |
| `THROTTLE_MAX_ENTRIES` | `10000` | Maximum in-memory IP counters per process; additional IPs share one overflow counter |

Empty values are treated as unset and use the default. Invalid values (for example `60s`, `1.5`, `0`, or `ENCRYPT_RESPONSE=FALSE`) stop the process at startup with an error naming the variable and the rejected value.

Rate-limited responses return HTTP 429 with `Retry-After`; responses from rate-limited routes also carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`. `/health` and `/public-key` are exempt. Each process tracks at most `THROTTLE_MAX_ENTRIES` counters. Once full, new IPs share an overflow counter until windows expire; this bounds memory but can make newly seen clients share a quota during an unusually high-cardinality burst.

Host and route rules are evaluated with **OR** semantics: hosts permitted by `ALLOWED_TARGET_HOSTS` are not restricted by `ALLOWED_ROUTES`. Use `ALLOWED_ROUTES` exclusively if you require strict method/path restrictions. Gateway rate limiting is tracked in-memory per instance; business rate limits remain in backend services. Configure `TRUST_PROXY` only for the exact trusted proxy hop count or subnet. Avoid `TRUST_PROXY=true` unless every path to the gateway is forced through a proxy that overwrites forwarded headers.

## Key Management

```bash
npm run keygen
```

Generates `keys/private.pem` and `keys/public.pem`, then prints `KeyId` alongside formatted strings for client SDKs. Output includes the base64-encoded private key for server environments; never share full output or commit it to public logs.

Key source resolution order: `RSA_PRIVATE_KEY` → `RSA_PRIVATE_KEY_PATH` → `keys/private.pem` → automatic generation if permitted. The private key must never be committed to Git or embedded in client apps.

Planned zero-downtime key rotation:

1. Generate the next key pair: `npm run keygen -- --out keys-next`.
2. Configure `RSA_PRIVATE_KEY=<new_base64_key>,<old_base64_key>` and redeploy the gateway.
3. Release client updates with the new public key and `KeyId`.
4. Remove the deprecated key from configuration after client migration is complete.

If an older key is compromised, retaining it for backwards compatibility maintains that risk; perform key revocations according to your deployment security policy.
