// clients/android/GatewayClient.kt
// In app/build.gradle.kts:
//   implementation("com.squareup.okhttp3:okhttp:4.12.0")
//   implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

package com.example.gateway

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.PublicKey
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

data class GatewayResult(
    val statusCode: Int,
    val headers: Map<String, String>,
    val data: Any?
)

/** Gateway error (400/429/502/504). `code`: UNKNOWN_KEY_ID, ... */
class GatewayException(val status: Int, val code: String?, message: String) : Exception(message)

class GatewayClient(
    private val gatewayUrl: String,
    serverPublicKeyPem: String,
    private val keyId: String? = null,
    private val http: OkHttpClient = OkHttpClient(),
    private val requireEncryptedResponse: Boolean = true,
) {
    private val serverKey: PublicKey = parsePublicKeyPem(serverPublicKeyPem)
    private val random = SecureRandom()

    /** Sends a request through the encryption gateway. */
    suspend fun send(
        method: String,
        accessPoint: String,
        headers: Map<String, String> = emptyMap(),
        body: Any? = null, // JSONObject, JSONArray, or String
        parameter: JSONObject? = null,
    ): GatewayResult = withContext(Dispatchers.IO) {
        val payload = JSONObject()
            .put("Method", method)
            .put("AccessPoint", accessPoint)
            .put("Header", JSONArray(headers.map { (k, v) -> JSONObject().put("Key", k).put("Value", v) }))
        if (body != null) payload.put("Body", body)
        if (parameter != null) payload.put("Parameter", parameter)

        // 1. Fresh AES key + IV for this request; 2. AES-256-GCM payload
        val aesKey = SecretKeySpec(randomBytes(32), "AES")
        val iv = randomBytes(12)
        val sealed = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
            doFinal(payload.toString().toByteArray(Charsets.UTF_8))
        }

        // 3. RSA-OAEP-SHA256 AES key (with MGF1-SHA256)
        val encryptedKey = Cipher.getInstance("RSA/ECB/OAEPPadding").run {
            init(Cipher.ENCRYPT_MODE, serverKey, OAEP_SHA256)
            doFinal(aesKey.encoded)
        }

        val requestObj = JSONObject()
            .put("EncryptedKey", b64(encryptedKey))
            .put("IV", b64(iv))
            .put("Payload", b64(sealed))
        if (keyId != null) requestObj.put("KeyId", keyId)

        val request = Request.Builder()
            .url(gatewayUrl)
            .post(requestObj.toString().toRequestBody("application/json".toMediaType()))
            .build()

        http.newCall(request).execute().use { res ->
            val text = res.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (res.code != 200) {
                throw GatewayException(
                    res.code,
                    json?.optString("code")?.ifEmpty { null },
                    json?.optString("message") ?: text
                )
            }

            val envelope = json ?: throw GatewayException(200, "INVALID_RESPONSE", "Invalid gateway response")
            val marker = envelope.opt("Encrypted")
            val result = if (marker == false) {
                if (requireEncryptedResponse) {
                    throw GatewayException(200, "ENCRYPTION_REQUIRED", "Encrypted response required; check ENCRYPT_RESPONSE on the server")
                }
                if (envelope.has("IV") || envelope.has("Payload")) {
                    throw GatewayException(200, "INVALID_RESPONSE", "Invalid gateway response")
                }
                envelope
            } else {
                if (marker != true && envelope.has("Encrypted")) {
                    throw GatewayException(200, "INVALID_RESPONSE", "Invalid gateway response")
                }
                // Legacy encrypted envelopes without a marker are also supported.
                val plain = Cipher.getInstance("AES/GCM/NoPadding").run {
                    init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, unb64(envelope.getString("IV"))))
                    doFinal(unb64(envelope.getString("Payload")))
                }
                JSONObject(String(plain, Charsets.UTF_8))
            }
            val statusCode = result.opt("StatusCode")
            if (statusCode !is Int || statusCode !in 100..599 ||
                result.optJSONObject("Headers") == null || !result.has("Data")) {
                throw GatewayException(200, "INVALID_RESPONSE", "Invalid gateway response")
            }

            val responseHeaders = mutableMapOf<String, String>()
            val rawHeaders = result.optJSONObject("Headers")
            if (rawHeaders != null) {
                for (k in rawHeaders.keys()) {
                    responseHeaders[k] = rawHeaders.getString(k)
                }
            }

            GatewayResult(
                statusCode = statusCode,
                headers = responseHeaders,
                data = result.opt("Data")
            )
        }
    }

    private fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }

    private companion object {
        val OAEP_SHA256 = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT)

        fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
        fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text)

        fun parsePublicKeyPem(pem: String): PublicKey {
            val der = unb64(pem.replace(Regex("-----[A-Z ]+-----|\\s"), ""))
            return KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der))
        }
    }
}
