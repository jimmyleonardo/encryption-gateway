# Deployment

## Docker Deployment

### 1. Prepare Configuration

```bash
git clone https://github.com/jimmyleonardo/encryption-gateway.git
cd encryption-gateway
cp .env.example .env
```

Replace demo values in `.env` with your actual production backend:

```env
PORT=3000
ALLOWED_ROUTES=POST api.example.com/api/login, GET api.example.com/api/profile
ALLOW_HTTP_UPSTREAM=false
ENCRYPT_RESPONSE=true

# For a single trusted reverse proxy in front of the gateway,
# with the gateway port inaccessible directly from the public internet.
TRUST_PROXY=1
```

Always use fully-qualified domain names for backends. Never leave `ALLOW_HTTP_UPSTREAM=true` enabled in production environments.

### 2. Launch the Gateway

```bash
docker compose up -d --build
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/public-key
```

If no keys exist, the gateway automatically generates an RSA-2048 key pair inside the named volume `gateway-keys`. This directory is owned by the container's non-root user (UID 1000). Host ports are bound exclusively to **`127.0.0.1:3000`**; all external incoming traffic must traverse an HTTPS reverse proxy.

No database or cache services are required. Ensure target lists are configured: if both `ALLOWED_ROUTES` and `ALLOWED_TARGET_HOSTS` are empty, all upstream requests will be rejected.

### 3. Setup HTTPS Reverse Proxy

Example configuration for Caddy running on the same host. Point your DNS A/AAAA records to the server and ensure standard HTTPS ports are open:

```caddyfile
gateway.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy after applying configuration. The endpoint used by client SDKs:

```text
https://gateway.example.com/api/gateway
```

The gateway communicates with your backend services over HTTPS. Configure `TRUST_PROXY` according to your specific proxy topology; use exact IP subnets or hop counts rather than copying `1` without reviewing network paths.

### 4. Distribute Public Key to Applications

Retrieve `pem` and `keyId` from `/public-key` over a trusted connection. For iOS, use `pkcs1Base64`. Embed the public key inside client builds; **the RSA private key must reside exclusively on the gateway server**.

### Updating Deployments & Keys

```bash
# After code updates
docker compose up -d --build

# After .env configuration changes
docker compose up -d --force-recreate gateway
```

Never delete the `gateway-keys` volume during redeployment. Deleting it forces the gateway to generate a new key identity, causing existing client apps to fail with decryption errors.

If previously using bind mounts (`./keys:/app/keys`), preserve existing keys during migration by copying them into the named volume, specifying `RSA_PRIVATE_KEY` via environment variables, or maintaining the bind mount with appropriate permissions for UID 1000.

### Diskless / Ephemeral Cloud Deployment

Generate keys locally via `npm run keygen`, then set the base64-encoded PEM output in the hosting platform's secret manager under `RSA_PRIVATE_KEY`. Set `ALLOWED_ROUTES`, `ALLOW_HTTP_UPSTREAM=false`, and `ENCRYPT_RESPONSE`. Use `/health` for container liveness probes (this probe does not perform synthetic upstream checks).

## Deploy to Vercel

The gateway runs on Vercel as a serverless function with the zero-config NestJS preset; no `vercel.json` is required.

1. Generate a key pair **dedicated to this deployment** outside the repository, and copy the `RSA_PRIVATE_KEY=` value it prints:

   ```bash
   npm run keygen -- --out ~/gateway-keys
   ```

2. In Vercel, **Add New → Project** and import your fork of this repository.
3. Before deploying, add these **Environment Variables**:

   | Key | Value |
   |---|---|
   | `RSA_PRIVATE_KEY` | Value from step 1, type **Secret**, environment **Production only** |
   | `ALLOWED_ROUTES` | Your upstream routes, e.g. `api.example.com/api/*` |
   | `ALLOW_HTTP_UPSTREAM` | `false` |
   | `TRUST_PROXY` | `1` (requests arrive through Vercel's edge proxy) |
   | `ENCRYPT_RESPONSE` | `true` |

4. Deploy, then check `https://<project>.vercel.app/public-key`. Delete the local key folder once the value is stored in Vercel.

Notes for serverless hosting:

- **Always set `RSA_PRIVATE_KEY`.** The filesystem is read-only and instances are recycled, so an auto-generated key would change between cold starts and break every client.
- **Keep the key out of Preview deployments.** Scope it to Production and leave Vercel's Git Fork Protection on, so pull requests from forks never receive the secret. Preview deployments therefore run without the production key and cannot decrypt real client traffic.
- **Rate limiting is per instance.** Counters live in memory, so each concurrent serverless instance enforces `THROTTLE_LIMIT` on its own and the effective global limit is higher. Use Vercel's firewall rate limiting or a shared store if you need a strict global limit.
- Variables left empty in the dashboard are treated as unset and fall back to their defaults.
