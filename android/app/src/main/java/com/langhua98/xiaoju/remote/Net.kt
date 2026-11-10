package com.langhua98.xiaoju.remote

import android.content.Context
import org.conscrypt.Conscrypt
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertificateFactory
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

class HttpError(val code: Int, msg: String) : Exception(msg)

/**
 * 联网。Android 4.2 自带的 TLS 和根证书都太旧，连不上现在的 HTTPS：
 * 用 Conscrypt 做 TLS，信任「系统根证书 + App 自带的 res/raw/roots.pem」。
 */
object Net {
    @Volatile private var factory: SSLSocketFactory? = null
    @Volatile private var trust: X509TrustManager? = null
    @Volatile private var ok: okhttp3.OkHttpClient? = null

    fun init(ctx: Context) {
        if (factory != null) return
        val provider = Conscrypt.newProvider()
        val ks = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null, null) }
        val anchors = ArrayList<java.security.cert.X509Certificate>()
        // 系统自带的根证书
        runCatching {
            val sys = KeyStore.getInstance("AndroidCAStore").apply { load(null, null) }
            for (alias in sys.aliases()) (sys.getCertificate(alias) as? java.security.cert.X509Certificate)?.let {
                ks.setCertificateEntry("sys-$alias", it); anchors.add(it)
            }
        }
        // App 自带的根证书
        val cf = CertificateFactory.getInstance("X.509")
        ctx.resources.openRawResource(R.raw.roots).use { input ->
            cf.generateCertificates(input).forEachIndexed { i, c ->
                ks.setCertificateEntry("app-$i", c); (c as? java.security.cert.X509Certificate)?.let { anchors.add(it) }
            }
        }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(ks) }
        val sys = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        // 系统验证不过时（Android 4.2 算不了新云盘的 ECDSA 证书链），用 Conscrypt 自己再验一遍证书链（见 ChainCheck）。
        // 只在验证时点名用 Conscrypt，不改全局的加密算法顺序（0.25 改了全局顺序，S4 上一打开就闪退）。
        val tm = FallbackTrustManager(sys, ChainCheck(anchors, provider))
        val ssl = SSLContext.getInstance("TLS", provider)
        ssl.init(null, arrayOf(tm), null)
        trust = tm
        factory = ssl.socketFactory
    }

    /**
     * Android 4.2 的 HttpsURLConnection 握手失败后会退回 SSLv3 再试，Conscrypt 不支持 SSLv3，
     * 报错就变成「No enabled protocols; SSLv3 …」，把真正的原因盖住了。遇到这种报错时自己握手一次，拿到真正的原因。
     */
    private fun realTlsError(url: String, e: java.io.IOException): java.io.IOException {
        if (e.message?.contains("SSLv3") != true) return e
        val f = factory ?: return e
        val u = URL(url)
        val port = if (u.port > 0) u.port else 443
        val why = try {
            // 不用 use {}：Android 4.2 的 Socket 还没实现 Closeable
            val raw = java.net.Socket()
            try {
                raw.connect(java.net.InetSocketAddress(u.host, port), 20_000)
                val ssl = f.createSocket(raw, u.host, port, true) as javax.net.ssl.SSLSocket
                ssl.soTimeout = 20_000
                ssl.startHandshake()
            } finally { runCatching { raw.close() } }
            return e   // 自己握手是好的：不是证书 / 协议的问题，原样报
        } catch (t: Exception) {
            generateSequence(t as Throwable) { it.cause }.last().let { it.message ?: it.javaClass.simpleName }
        }
        return java.io.IOException("HTTPS 握手失败：$why", e)
    }

    /**
     * 直播用的 WebSocket 客户端（OkHttp 3.12，支持 Android 2.3+），TLS 同样走 Conscrypt + 自带根证书。
     * 读超时关掉（长连接可能很久没消息），靠每 20 秒一次心跳发现断线。
     */
    @Synchronized fun okHttp(): okhttp3.OkHttpClient {
        ok?.let { return it }
        val f = factory ?: throw IllegalStateException("Net 还没初始化")
        val c = okhttp3.OkHttpClient.Builder()
            .sslSocketFactory(f, trust!!)
            .connectTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .writeTimeout(20, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(0, java.util.concurrent.TimeUnit.MILLISECONDS)
            .pingInterval(20, java.util.concurrent.TimeUnit.SECONDS)
            .build()
        ok = c
        return c
    }

    /**
     * 发一个请求，返回响应体。非 2xx 抛 HttpError。
     * throttleBps > 0：上传时限速（字节/秒），慢慢传，不占满老手机的上行。
     *
     * 省电：reuse = true 的请求（收指令的长轮询，一轮接一轮、中间几乎不停）成功后不断开连接，
     * 下一轮接着用，不用每 25 秒重新连、重新做 TLS 握手。
     * 其他请求（回执、上传…）每次都用新连接（Connection: close）：0.13、0.14 让它们也复用，结果连接闲了
     * 几十秒后被运营商的 NAT 悄悄掐掉，再拿来发回执就一直等到超时（拍照回执要等一分钟），0.15 改回来。
     * 复用的旧连接坏了时，GET 马上用新连接再试一次。
     */
    fun request(method: String, url: String, token: String, body: ByteArray? = null,
                contentType: String? = null, readTimeoutMs: Int = 60_000, throttleBps: Int = 0,
                onConn: ((HttpURLConnection?) -> Unit)? = null, reuse: Boolean = false): ByteArray =
        try {
            try {
                requestOnce(method, url, token, body, contentType, readTimeoutMs, throttleBps, onConn, reuse)
            } catch (e: java.io.IOException) {
                // 只重试 GET；等太久（读超时）不算连接坏了，不重试
                if (method != "GET" || e is java.net.SocketTimeoutException || e.message?.contains("SSLv3") == true) throw e
                requestOnce(method, url, token, body, contentType, readTimeoutMs, throttleBps, onConn, false)
            }
        } catch (e: java.io.IOException) {
            throw realTlsError(url, e)
        }

    /** onConn：连接建好时交出来（别的线程可以 disconnect() 把卡住的请求断掉），结束时交 null。 */
    private fun requestOnce(method: String, url: String, token: String, body: ByteArray?,
                            contentType: String?, readTimeoutMs: Int, throttleBps: Int,
                            onConn: ((HttpURLConnection?) -> Unit)?, reuse: Boolean): ByteArray {
        val conn = URL(url).openConnection() as HttpURLConnection
        onConn?.invoke(conn)
        var keep = false
        try {
            if (conn is HttpsURLConnection) factory?.let { conn.sslSocketFactory = it }
            conn.requestMethod = method
            conn.connectTimeout = 20_000
            conn.readTimeout = readTimeoutMs
            conn.useCaches = false
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/json")
            if (!reuse) conn.setRequestProperty("Connection", "close")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", contentType ?: "application/octet-stream")
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { out ->
                    if (throttleBps <= 0) out.write(body)
                    else {
                        val chunk = 16 * 1024
                        val start = System.currentTimeMillis()
                        var off = 0
                        while (off < body.size) {
                            val n = minOf(chunk, body.size - off)
                            out.write(body, off, n)
                            off += n
                            val due = start + off * 1000L / throttleBps
                            val wait = due - System.currentTimeMillis()
                            if (wait > 0) Thread.sleep(wait)
                        }
                    }
                }
            }
            val code = conn.responseCode
            val stream: InputStream? = if (code in 200..299) conn.inputStream else conn.errorStream
            val data = stream?.use { readAll(it) } ?: ByteArray(0)
            if (code !in 200..299) {
                val msg = runCatching { org.json.JSONObject(String(data, Charsets.UTF_8)) }.getOrNull()
                    ?.let { j -> j.optString("message").ifBlank { j.optString("error") } +
                        j.optString("hint").let { if (it.isBlank()) "" else "（$it）" } }.orEmpty()
                throw HttpError(code, "云盘 $code" + if (msg.isBlank()) "" else "：$msg")
            }
            keep = reuse
            return data
        } finally {
            onConn?.invoke(null)
            // 成功：留着连接给下一个请求；出错：断开，免得把坏连接放回连接池
            if (!keep) conn.disconnect()
        }
    }

    /**
     * 下载一个大文件（安装包）直接写到 dest，不整个放进内存。返回写了多少字节。非 2xx 抛 HttpError。
     * 服务器说了长度而没下完整，抛 IOException。
     */
    fun download(url: String, token: String, dest: java.io.File): Long {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            if (conn is HttpsURLConnection) factory?.let { conn.sslSocketFactory = it }
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.useCaches = false
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Connection", "close")
            val code = conn.responseCode
            if (code !in 200..299) {
                conn.errorStream?.use { readAll(it) }
                throw HttpError(code, "云盘 $code")
            }
            val expect = conn.getHeaderField("Content-Length")?.toLongOrNull() ?: -1L
            var total = 0L
            conn.inputStream.use { input ->
                java.io.FileOutputStream(dest).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        total += n
                    }
                    out.fd.sync()
                }
            }
            if (expect >= 0 && total != expect) throw java.io.IOException("只下了 $total / $expect 字节")
            return total
        } finally {
            conn.disconnect()
        }
    }

    private fun readAll(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}
