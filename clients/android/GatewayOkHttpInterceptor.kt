package com.example.gateway

import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * Last APPLICATION interceptor on the logical backend API client.
 * Put Chucker before it to capture plaintext requests and decrypted responses.
 * GatewayClient must use a separate transport without this interceptor.
 * Supports bounded JSON/text bodies and unique request header names, without streaming.
 * The separate transport owns network timeouts; logical call cancellation is checked
 * before/after the gateway call and does not interrupt its in-flight transport call.
 */
class GatewayOkHttpInterceptor(
    private val gateway: GatewayClient,
    backendOrigin: String,
    private val maxBodyBytes: Long = 512 * 1024,
) : Interceptor {
    private val origin = backendOrigin.toHttpUrl().also {
        require(it.isHttps && it.encodedPath == "/" && it.query == null && it.fragment == null) {
            "backendOrigin must be an HTTPS origin without a path or query"
        }
    }

    init { require(maxBodyBytes > 0) }

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        try {
            if (chain.call().isCanceled()) throw IOException("Canceled")
            require(request.url.scheme == origin.scheme && request.url.host == origin.host &&
                request.url.port == origin.port) { "Unexpected backend origin" }
            require(request.method in setOf("GET", "POST", "PUT", "PATCH", "DELETE")) { "Unsupported method" }
            val body = request.body
            require(body?.isOneShot() != true && body?.isDuplex() != true) { "Streaming is unsupported" }
            val plaintext: Any? = if (body == null) null else {
                require(body.contentLength() in 0..maxBodyBytes) { "Expected a bounded body" }
                val media = body.contentType() ?: throw IOException("Missing body content type")
                require(media.type == "text" ||
                    (media.type == "application" && (media.subtype == "json" || media.subtype.endsWith("+json")))) {
                    "Only JSON and text bodies are supported"
                }
                val buffer = Buffer()
                val text = try {
                    body.writeTo(buffer)
                    require(buffer.size <= maxBodyBytes) { "Body too large" }
                    buffer.readString(media.charset(Charsets.UTF_8) ?: Charsets.UTF_8)
                } finally { buffer.clear() }
                if (media.type == "application") {
                    val trimmed = text.trim()
                    when {
                        trimmed.startsWith("{") -> JSONObject(trimmed)
                        trimmed.startsWith("[") -> JSONArray(trimmed)
                        else -> text // The gateway supports JSON scalar and legacy string bodies.
                    }
                } else text
            }
            val headers = request.headers.names().filter { it.lowercase() !in transportHeaders }
                .associateWith { name ->
                    require(request.headers.values(name).size == 1) { "Duplicate request headers are unsupported" }
                    request.header(name)!!
                }.toMutableMap()
            if (headers.keys.none { it.equals("Content-Type", true) }) {
                body?.contentType()?.let { headers["Content-Type"] = it.toString() }
            }
            // The query remains in AccessPoint, preserving repeated query values and encoding.
            val result = runBlocking {
                gateway.send(request.method, request.url.toString(), headers = headers, body = plaintext)
            }
            if (chain.call().isCanceled()) throw IOException("Canceled")
            require(result.statusCode in 200..599) { "Unsupported upstream status" }
            val media = result.headers.entries.firstOrNull { it.key.equals("Content-Type", true) }
                ?.value?.firstOrNull()?.toMediaTypeOrNull() ?: "application/json".toMediaType()
            val isJson = media.subtype == "json" || media.subtype.endsWith("+json")
            val text = if (result.statusCode in setOf(204, 205, 304)) "" else when (val data = result.data) {
                null, JSONObject.NULL -> if (isJson) "null" else ""
                is String -> if (isJson) JSONObject.quote(data) else data
                else -> data.toString()
            }
            return response(request, result.statusCode, text, media.toString()).newBuilder().apply {
                result.headers.forEach { (name, values) ->
                    if (name.lowercase() !in transportHeaders && !name.equals("Content-Encoding", true)) {
                        values.forEach { addHeader(name, it) }
                    }
                }
                header("Content-Type", media.toString())
                header("Cache-Control", "no-store")
            }.build()
        } catch (error: GatewayException) {
            if (error.status !in 400..599) throw IOException("Invalid gateway response", error)
            // Make gateway errors readable in Chucker too, distinguished from backend errors.
            val body = JSONObject().put("statusCode", error.status)
                .put("message", error.message).apply { error.code?.let { put("code", it) } }
            return response(request, error.status, body.toString(), "application/json")
                .newBuilder().header("X-Gateway-Error", "true").build()
        } catch (error: IOException) {
            throw error
        } catch (error: Exception) {
            throw IOException("Encryption Gateway request failed", error)
        }
    }

    private fun response(request: Request, status: Int, text: String, type: String): Response =
        Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
            .code(status).message("Gateway response")
            .header("Cache-Control", "no-store")
            .body(text.toResponseBody(type.toMediaType())).build()

    private companion object {
        val transportHeaders = setOf("host", "content-length", "transfer-encoding", "connection",
            "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "upgrade", "accept-encoding")
    }
}
