# Attestation and anti-MOD verification

The gateway includes an **optional, decoupled Attestation Module** (`AttestationModule`)
that validates **Android Hardware Key Attestation** (TEE / StrongBox) and enforces app
integrity against **repackaging and MOD APKs**.

> **Optional and vendor-neutral.** This module verifies *standard* Android Key
> Attestation as specified by Google — the X.509 chain and `KeyDescription`
> extension that any Android Keystore produces. It does not require a companion
> SDK. If you clone this gateway and never set `ATTESTATION_PACKAGE_NAME` /
> `ATTESTATION_SIGNING_CERT_SHA256`, the module stays inert: the gateway runs
> exactly as before and `/v1/devices/*` reports `503`.
>
> The module is already registered in `AppModule`; enabling it only requires the
> environment values below. No source edit is needed.

## How It Works

1. **Hardware Root of Trust**: Keys are generated inside the device's hardware chip (ARM TrustZone / StrongBox Titan M). Private keys cannot be extracted by root tools or Frida in userspace.
2. **Server-Bound Challenge**: The server issues a single-use random nonce. The device hardware signs the nonce and embeds verified OS metadata directly into the X.509 certificate chain.
3. **Strict Verification**:
   - **Google Attestation Root CA**: Root certificates verify device authenticity.
   - **Authentic APK Signature (`SIGNER_NOT_ALLOWED`)**: The Android OS/TEE injects the APK's real signing certificate hash into the leaf cert. Repacked or modded APKs are signed with a different key and immediately rejected.
   - **Verified Boot State (`BOOTLOADER_UNLOCKED`)**: Rooted devices or devices with unlocked bootloaders are detected at the hardware level.

## Enabling It For Your Own App

Nothing in this repository needs editing — the two values below are per-deployment
configuration, so every clone points the module at its own app.

**1. Find your package name.** The `applicationId` in your app module's `build.gradle`.

**2. Find your release signing certificate SHA-256.**

```bash
# From a built release APK (what the device actually reports):
keytool -printcert -jarfile app-release.apk | grep SHA256

# Or from the keystore you sign with:
keytool -list -v -keystore release.jks -alias my-alias | grep SHA256
```

> **If you use Google Play App Signing, neither command above gives the right value.**
> Google re-signs your app with *its* key, and that is the certificate the device
> attests. Take the SHA-256 from **Play Console → your app → Test and release →
> App integrity → App signing key certificate**. Using your upload key instead is
> the most common cause of every enrolment failing with `SIGNER_NOT_ALLOWED`.

**3. Set them where the gateway runs** — never in the repository:

- **Local development**: create `.env` (already gitignored; copy `.env.example`).
- **Vercel**: Settings → Environment Variables.
- **Docker**: `--env-file` or `environment:` in `docker-compose.yml`.

```bash
ATTESTATION_PACKAGE_NAME=com.yourcompany.yourapp
ATTESTATION_SIGNING_CERT_SHA256=A1:B2:C3:...        # colons optional
```

Both must be set together. Set neither and the module stays inert. Colons and case
are normalised, and several certificates may be comma-separated — useful while
rotating a signing key, or to accept both a debug and a release build.

Only **one package name** is verified per deployment. Serving several apps from one
gateway would need a change in `src/attestation/attestation.service.ts`.

**4. Verify it works** before pointing your app at it:

```bash
curl -X POST https://your-gateway/v1/challenges \
  -H "Content-Type: application/json" -d '{"purpose":"enroll"}'
```

A `503 ATTESTATION_NOT_CONFIGURED` from `/v1/devices/enroll` means the two variables
did not reach the process.

## Deployment State (read before deploying)

Challenges and device enrolments are stored behind a small key/value port:

- **Default (in-memory)**: per-process. Fine for a single long-running instance. On a restart every enrolment is lost.
- **Shared (Upstash / Vercel KV)**: set `ATTESTATION_KV_REST_URL` and `ATTESTATION_KV_REST_TOKEN`.

**On Vercel or any multi-instance host the shared store is required.** Serverless
invocations do not share memory, so a device enrolled by one invocation is unknown
to the next and `/v1/devices/verify` will fail unpredictably.

## Current Limitations

- **Enrollment is unauthenticated.** Any caller that can produce a genuine attestation from an authentic build of the app can claim an unused `deviceId`. Put your own application authentication in front of `/v1/devices/enroll` to bind a device to a user account.
- **Enrollment is single-shot per device id.** An id already enrolled is never re-bound to a different key; rotating a key means deleting the enrolment out of band first. This is deliberate — silent re-binding would let anyone who guesses an id take over the device.
- **Revocation is a static list.** `ATTESTATION_REVOKED_SERIALS` is read at startup; Google's attestation CRL is not fetched.
- **Only Android Key Attestation is verified.** iOS App Attest is not implemented server-side.

## Non-GMS Devices & "UNTRUSTED_ROOT" (e.g. Huawei, FireOS)

> **Important Distinction:** An `UNTRUSTED_ROOT` error refers to the cryptographic **X.509 Root Certificate Authority (CA)**, **NOT** Android OS rooting (Magisk/su). A completely unrooted phone can still report `UNTRUSTED_ROOT`.

- **Google-Certified Devices**: Android devices with official Google Mobile Services (GMS) have hardware keystore roots provisioned and signed by the **Google Attestation Root CA**.
- **Non-GMS Devices (e.g. Huawei post-2019, Amazon FireOS, Custom ROMs)**: Devices without Google certification lack Google's hardware root provisioning. When generating key attestation, their Keystore terminates at an AOSP software root or a vendor-specific root.
- **Gateway Security Enforcement**: By default, the gateway strictly rejects any certificate chain that does not terminate at Google's official Attestation Root (`code: "UNTRUSTED_ROOT"`). In high-security production environments (banking, fintech), this ensures keys physically reside in verified, tamper-resistant Google-certified hardware chips.
- **Testing on Non-GMS / Huawei / Emulators**: To accept software/non-Google roots for testing and development, set:
  ```env
  ATTESTATION_ALLOW_SOFTWARE=true
  # (or alias: AEGIS_EMULATOR_MODE=true)
  ```
  *(Note: Startup fails if this is `true` while `NODE_ENV=production`. On testing deployments, ensure `NODE_ENV=development` or `staging`).*

## Attestation Endpoints

### 1. `POST /v1/challenges`
Requests a fresh, single-use cryptographic challenge nonce (valid for 60s).
```bash
curl -X POST https://encryption-gateway.vercel.app/v1/challenges \
  -H "Content-Type: application/json" \
  -d '{"purpose": "enroll"}'
```
Response:
```json
{
  "challengeId": "3b29c9a0-975a-4b92-8051-26c11d8825e7",
  "nonce": "kM9w8X...=="
}
```

### 2. `POST /v1/devices/enroll`
Enrolls an authentic device by verifying its hardware certificate chain.
```bash
curl -X POST https://encryption-gateway.vercel.app/v1/devices/enroll \
  -H "Content-Type: application/json" \
  -d '{
    "challengeId": "3b29c9a0-975a-4b92-8051-26c11d8825e7",
    "deviceId": "client-device-uuid",
    "certificateChain": ["<base64-leaf-cert>", "<base64-intermediate-cert>", "<base64-root-cert>"]
  }'
```
Response:
```json
{ "status": "enrolled", "securityLevel": 1 }
```

### 3. `POST /v1/devices/verify`
Proves possession of the enrolled hardware private key by signing a fresh challenge
nonce. The challenge must have been requested with `"purpose": "verify"`.
```bash
curl -X POST https://encryption-gateway.vercel.app/v1/devices/verify \
  -H "Content-Type: application/json" \
  -d '{
    "challengeId": "<fresh-challenge-id>",
    "deviceId": "client-device-uuid",
    "signature": "<base64-ecdsa-signature>"
  }'
```
Response:
```json
{ "status": "verified" }
```
