# Read plain requests and responses in Chucker

Use `GatewayOkHttpInterceptor` to keep ordinary OkHttp/Retrofit calls readable in Chucker while sending encrypted envelopes through the encryption server.

```text
Request:  OkHttp / Retrofit → application headers → Chucker → gateway adapter → encryption server
Response: OkHttp / Retrofit ←                     Chucker ← decrypted backend response
```

Chucker records the **backend URL, original method, plaintext request body, backend response status, and decrypted response body**. The separate network transport sends `EncryptedKey`, `IV`, and `Payload` to `/api/gateway`. No gateway-server changes are required. Both `ENCRYPT_RESPONSE=true` and the explicitly permitted plain-response mode work.

## Files and dependencies

Copy both files into the same application package:

- [GatewayClient.kt](../clients/android/GatewayClient.kt)
- [GatewayOkHttpInterceptor.kt](../clients/android/GatewayOkHttpInterceptor.kt)

Adjust `package com.example.gateway` and the imports below if your package differs.

```kotlin
// app/build.gradle.kts
implementation("com.squareup.okhttp3:okhttp:4.12.0")
implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
debugImplementation("com.github.chuckerteam.chucker:library:4.2.0")
releaseImplementation("com.github.chuckerteam.chucker:library-no-op:4.2.0")
```

The SDK uses `java.util.Base64`; use Android API 26+ or configure compatible desugaring for older devices. See [Chucker's documentation](https://github.com/ChuckerTeam/chucker#readme) for its build requirements.

## Configure two clients

`context` is your Android context, `serverPublicKeyPem` and `keyId` are your bundled gateway key configuration, and `accessTokenProvider()` reads your app's current token.

```kotlin
import com.chuckerteam.chucker.api.ChuckerInterceptor
import com.example.gateway.GatewayClient
import com.example.gateway.GatewayOkHttpInterceptor
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

// 1. Actual network transport to the encryption server.
val transport = OkHttpClient.Builder()
    .callTimeout(30, TimeUnit.SECONDS)
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

val gateway = GatewayClient(
    gatewayUrl = "https://gateway.example.com/api/gateway",
    serverPublicKeyPem = serverPublicKeyPem,
    keyId = keyId,
    http = transport,
    requireEncryptedResponse = true,
)

// 2. Logical backend API client. Chucker observes this client.
val applicationHeaders = Interceptor { chain ->
    val request = chain.request().newBuilder().apply {
        accessTokenProvider()?.let { header("Authorization", "Bearer $it") }
    }.build()
    chain.proceed(request)
}

val chucker = ChuckerInterceptor.Builder(context)
    .redactHeaders("Authorization", "Cookie", "Set-Cookie")
    .build()

val apiClient = OkHttpClient.Builder()
    .addInterceptor(applicationHeaders)
    .apply { if (BuildConfig.DEBUG) addInterceptor(chucker) }
    .addInterceptor(
        GatewayOkHttpInterceptor(gateway, "https://api.example.com/")
    ) // Last application interceptor.
    .build()
```

If your app already has an Aegis policy interceptor, it can run before `applicationHeaders`; the plaintext capture works independently of it.

Register Chucker with **`addInterceptor`**, not `addNetworkInterceptor`. Keep the gateway adapter last. Use the logical `apiClient` for all backend calls. The `transport` must be a separate client without this adapter; adding the adapter there would recursively wrap gateway traffic. Putting Chucker only on `transport` displays ciphertext.

Headers added before Chucker are visible in its capture and passed to the backend inside the encrypted payload. Header redaction does not remove sensitive values from JSON bodies; plaintext capture belongs in debug builds.

## Send an ordinary request

The URL is the **backend URL**, not the encryption-server URL. Its method and body remain the same as a direct backend call:

```kotlin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

val request = Request.Builder()
    .url("https://api.example.com/api/profile")
    .patch(
        """{"name":"Budi Santoso","email":"invalid-email"}"""
            .toRequestBody("application/json".toMediaType())
    )
    .build()

// Execute on a worker thread, or use OkHttp enqueue().
apiClient.newCall(request).execute().use { response ->
    println(response.code) // Actual backend status, e.g. 422.
    println(response.body?.string()) // Plain backend response JSON.
}
```

For Retrofit, pass `apiClient` to `.client(apiClient)` and keep `.baseUrl("https://api.example.com/")`. The adapter turns the gateway envelope back into the backend body expected by your existing Retrofit JSON converter.

Example Chucker capture:

```text
URL:    https://api.example.com/api/profile
Method: PATCH

Request body:
{"name":"Budi Santoso","email":"invalid-email"}

Response status: 422
Response body:
{"success":false,"error":{"code":"VALIDATION_FAILED","message":"Email is invalid"}}
```

The real transport still uses `POST https://gateway.example.com/api/gateway` with an encrypted envelope. Chucker displays a reconstructed **logical backend transaction**. It shows the business status (such as 201 or 422), while the successful gateway transport uses HTTP 200. Its elapsed time covers the adapter/gateway round trip; it does not represent a direct socket connection to the backend.

## Responses, errors, and scope

Repeated response headers, including `Set-Cookie`, are restored using multiple OkHttp header entries. JSON objects/arrays and text response bodies are readable. Bodyless 204/205/304 responses stay empty.

Gateway HTTP errors are also returned as readable OkHttp responses, with `X-Gateway-Error: true` to distinguish them from backend business errors. Failed ciphertext authentication and transport failures remain `IOException`s; they are never returned as plaintext business successes.

The adapter supports GET/POST/PUT/PATCH/DELETE, one configured HTTPS backend origin, unique request header names, and buffered JSON/text request bodies up to 512 KiB by default. Query strings are preserved in the target URL. Configure `maxBodyBytes` only within your server body-size limits; envelope/base64 overhead also counts toward `MAX_BODY_SIZE`. Multipart, binary, duplex, one-shot, and unknown-length request bodies are rejected.

Actual network timeouts are controlled by `transport`. Cancellation on the logical call is checked before and after the gateway operation, but does not interrupt the internally running transport call. Use finite transport timeouts; this adapter is intended for bounded JSON/text API calls.

## Regression tests

[GatewayOkHttpInterceptorTest.kt](../test/android/GatewayOkHttpInterceptorTest.kt) verifies the plaintext capture point, encrypted wire body, restored backend status, repeated response headers, both response modes, DELETE bodies, text responses, gateway errors, tampered ciphertext, and origin rejection.

Copy it into your app's JVM test source set under the same package and add:

```kotlin
testImplementation("junit:junit:4.13.2")
testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
testImplementation("org.json:json:20240303")
```

The tests use a recording application interceptor at the same point where Chucker is installed. Actual Chucker UI inspection requires running your Android app.
