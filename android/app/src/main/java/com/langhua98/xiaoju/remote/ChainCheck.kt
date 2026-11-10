package com.langhua98.xiaoju.remote

import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.Provider
import java.security.PublicKey
import java.security.Signature
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.X509EncodedKeySpec
import java.util.Date
import javax.net.ssl.X509TrustManager

/**
 * 系统的证书验证不过时，自己再验一遍证书链。
 *
 * 2026-11 云盘搬到家里电脑（Tailscale），证书是 Let's Encrypt 的 ECDSA 证书链：
 * 网站证书 → YE2 → Root YE → ISRG Root X2（X2 在 res/raw/roots.pem 里）。Android 4.2 自带的验证算不了这种签名，
 * 握手失败后系统再退回 SSLv3，最后只看到「No enabled protocols; SSLv3 …」。
 *
 * 这里把证书交给 [provider]（App 里是 Conscrypt）重新解析、验签名：一级一级往上，每一级要在有效期内、
 * 上一级是 CA、签名对得上，直到某一级是根证书、或者由根证书签发。域名由 HttpsURLConnection / OkHttp 另外核对。
 * provider 为 null 时用系统默认的算法（电脑上跑测试用）。不碰安卓的类。
 */
class ChainCheck(anchors: List<X509Certificate>, private val provider: Provider?) {
    private val roots: List<X509Certificate> = anchors.mapNotNull { runCatching { parse(it) }.getOrNull() }

    fun verify(chain: Array<out X509Certificate>, now: Date = Date()) {
        if (chain.isEmpty()) throw CertificateException("没有证书")
        val certs = chain.map { parse(it) }
        for ((i, c) in certs.withIndex()) {
            // 这一级本身就是根证书
            if (roots.any { same(it, c) }) return
            c.checkValidity(now)
            if (i > 0 && c.basicConstraints < 0) throw CertificateException("中间证书不是 CA：${c.subjectX500Principal}")
            // 由根证书签发
            for (r in roots) {
                if (r.subjectX500Principal == c.issuerX500Principal && runCatching { checkSig(c, r.publicKey) }.isSuccess) return
            }
            val next = certs.getOrNull(i + 1) ?: throw CertificateException("找不到可信的根证书：${c.issuerX500Principal}")
            if (next.subjectX500Principal != c.issuerX500Principal) throw CertificateException("证书链断了：${c.issuerX500Principal}")
            checkSig(c, next.publicKey)
        }
        throw CertificateException("找不到可信的根证书")
    }

    private fun parse(c: X509Certificate): X509Certificate {
        val cf = if (provider != null) CertificateFactory.getInstance("X.509", provider) else CertificateFactory.getInstance("X.509")
        return cf.generateCertificate(ByteArrayInputStream(c.encoded)) as X509Certificate
    }

    private fun same(a: X509Certificate, b: X509Certificate) =
        a.subjectX500Principal == b.subjectX500Principal && a.publicKey.encoded.contentEquals(b.publicKey.encoded)

    private fun checkSig(c: X509Certificate, key: PublicKey) {
        val alg = SIG_ALGS[c.sigAlgOID] ?: throw CertificateException("不认识的签名算法 ${c.sigAlgOID}")
        val keyAlg = if (alg.endsWith("ECDSA")) "EC" else "RSA"
        val kf = if (provider != null) KeyFactory.getInstance(keyAlg, provider) else KeyFactory.getInstance(keyAlg)
        val pub = kf.generatePublic(X509EncodedKeySpec(key.encoded))
        val sig = if (provider != null) Signature.getInstance(alg, provider) else Signature.getInstance(alg)
        sig.initVerify(pub)
        sig.update(c.tbsCertificate)
        if (!sig.verify(c.signature)) throw CertificateException("签名对不上：${c.subjectX500Principal}")
    }

    companion object {
        val SIG_ALGS = mapOf(
            "1.2.840.113549.1.1.5" to "SHA1withRSA",
            "1.2.840.113549.1.1.11" to "SHA256withRSA",
            "1.2.840.113549.1.1.12" to "SHA384withRSA",
            "1.2.840.113549.1.1.13" to "SHA512withRSA",
            "1.2.840.10045.4.1" to "SHA1withECDSA",
            "1.2.840.10045.4.3.2" to "SHA256withECDSA",
            "1.2.840.10045.4.3.3" to "SHA384withECDSA",
            "1.2.840.10045.4.3.4" to "SHA512withECDSA",
        )
    }
}

/** 先用系统的验证；不过的话用 [ChainCheck] 再验一遍。任何意外（包括 Error）都只当验证失败，不让 App 闪退。 */
class FallbackTrustManager(private val sys: X509TrustManager, private val check: ChainCheck) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = sys.checkClientTrusted(chain, authType)
    override fun getAcceptedIssuers(): Array<X509Certificate> = sys.acceptedIssuers

    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
        val first = try { sys.checkServerTrusted(chain, authType); return } catch (t: Throwable) { t }
        try { check.verify(chain) } catch (t: Throwable) {
            throw CertificateException("证书验证不过（系统：${first.message}；自己验：${t.message ?: t.javaClass.simpleName}）", first)
        }
    }
}
