package com.example.gateway

import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.spec.MGF1ParameterSpec
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/** Copy into the app's JVM test source set with OkHttp MockWebServer and org.json. */
class GatewayOkHttpInterceptorTest {
    private val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    private val server = MockWebServer()
    private lateinit var client: OkHttpClient
    private var wireRequest: String? = null
    private var decodedRequest: JSONObject? = null
    private var capturedRequest: String? = null
    private var capturedResponse: String? = null
    private var capturedStatus = 0
    private var plainMode = false
    private var corruptResponse = false
    private var gatewayStatus = 200
    private var backendStatus = 422
    private var backendData: Any = JSONObject().put("message", "Email is invalid").put("field", "email")
    private var responseContentType = "application/json"

    @Before fun setup() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                wireRequest = request.body.readUtf8()
                if (gatewayStatus != 200) return MockResponse().setResponseCode(gatewayStatus)
                    .setBody(JSONObject().put("message", "Upstream timed out").toString())
                val envelope = JSONObject(wireRequest!!)
                val unwrap = Cipher.getInstance("RSA/ECB/OAEPPadding")
                unwrap.init(Cipher.DECRYPT_MODE, pair.private,
                    OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT))
                val key = SecretKeySpec(unwrap.doFinal(Base64.getDecoder().decode(envelope.getString("EncryptedKey"))), "AES")
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.getDecoder().decode(envelope.getString("IV"))))
                decodedRequest = JSONObject(String(cipher.doFinal(Base64.getDecoder().decode(envelope.getString("Payload"))), Charsets.UTF_8))
                val result = JSONObject().put("StatusCode", backendStatus).put("Data", backendData)
                    .put("Headers", JSONObject().put("content-type", responseContentType)
                        .put("set-cookie", JSONArray(listOf("a=1; Path=/", "b=2; Path=/"))))
                if (plainMode) return MockResponse().setBody(result.put("Encrypted", false).toString())
                val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
                cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
                val sealed = cipher.doFinal(result.toString().toByteArray(Charsets.UTF_8))
                if (corruptResponse) sealed[0] = (sealed[0].toInt() xor 1).toByte()
                return MockResponse().setBody(JSONObject().put("Encrypted", true)
                    .put("IV", Base64.getEncoder().encodeToString(iv))
                    .put("Payload", Base64.getEncoder().encodeToString(sealed)).toString())
            }
        }
        server.start()
        val pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getEncoder().encodeToString(pair.public.encoded) + "\n-----END PUBLIC KEY-----"
        val transport = OkHttpClient.Builder().callTimeout(3, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false).build()
        val gateway = GatewayClient(server.url("/api/gateway").toString(), pem,
            http = transport, requireEncryptedResponse = false)
        client = OkHttpClient.Builder().addInterceptor { chain ->
            // Same capture point as Chucker's application interceptor.
            val buffer = Buffer()
            chain.request().body?.writeTo(buffer)
            capturedRequest = buffer.readUtf8()
            val response = chain.proceed(chain.request())
            capturedResponse = response.peekBody(1024 * 1024).string()
            capturedStatus = response.code
            response
        }.addInterceptor(GatewayOkHttpInterceptor(gateway, "https://api.example.com/"))
            .build()
    }

    @After fun teardown() { server.shutdown() }

    private fun execute(method: String = "POST", text: String = "{\"email\":\"invalid\",\"password\":\"demo-password\"}"): Response =
        client.newCall(Request.Builder().url("https://api.example.com/api/profile?locale=id&tag=a&tag=b")
            .header("Authorization", "Bearer demo-token")
            .method(method, text.toRequestBody("application/json".toMediaType())).build()).execute()

    @Test fun captureSeesPlaintextAndBackendStatusWhileTransportCarriesCiphertext() {
        execute().use { response ->
            assertTrue(capturedRequest!!.contains("demo-password"))
            assertFalse(wireRequest!!.contains("demo-password"))
            assertFalse(wireRequest!!.contains("demo-token"))
            assertTrue(JSONObject(wireRequest!!).has("EncryptedKey"))
            assertEquals(422, capturedStatus)
            assertEquals("Email is invalid", JSONObject(capturedResponse!!).getString("message"))
            assertEquals(2, response.headers.values("set-cookie").size)
            assertEquals("application/json", response.header("Content-Type"))
            assertEquals("https://api.example.com/api/profile?locale=id&tag=a&tag=b", decodedRequest!!.getString("AccessPoint"))
            assertEquals("https://api.example.com", response.request.url.scheme + "://" + response.request.url.host)
            assertEquals("invalid", decodedRequest!!.getJSONObject("Body").getString("email"))
            val headers = decodedRequest!!.getJSONArray("Header")
            assertTrue((0 until headers.length()).any { headers.getJSONObject(it).optString("Key") == "Authorization" && headers.getJSONObject(it).optString("Value") == "Bearer demo-token" })
        }
    }

    @Test fun plainResponseModeHasTheSameReadableCapture() {
        plainMode = true
        execute().use { assertEquals(backendData.toString(), capturedResponse) }
    }

    @Test fun deleteBodyIsEncryptedAndForwarded() {
        backendStatus = 200
        execute("DELETE", "{\"ids\":[1,2]}").use {
            assertEquals("DELETE", decodedRequest!!.getString("Method"))
            assertEquals(2, decodedRequest!!.getJSONObject("Body").getJSONArray("ids").length())
        }
    }

    @Test fun textResponseIsReadableWithoutJsonQuotes() {
        backendStatus = 200
        backendData = "Hello from backend"
        responseContentType = "text/plain"
        execute().use { assertEquals("Hello from backend", capturedResponse) }
    }

    @Test fun gatewayErrorsAreReadableAndIdentified() {
        gatewayStatus = 504
        execute().use {
            assertEquals(504, capturedStatus)
            assertEquals("true", it.header("X-Gateway-Error"))
            assertTrue(capturedResponse!!.contains("Upstream timed out"))
        }
    }

    @Test fun corruptedCiphertextNeverBecomesAPlaintextSuccess() {
        corruptResponse = true
        try { execute().close(); fail("Expected authentication failure") }
        catch (_: IOException) { assertNull(capturedResponse) }
    }

    @Test fun anotherOriginIsRejectedBeforeAnyGatewayTraffic() {
        try {
            client.newCall(Request.Builder().url("https://other.example.com/").build()).execute().close()
            fail("Expected origin rejection")
        } catch (_: IOException) { assertEquals(0, server.requestCount) }
    }
}
