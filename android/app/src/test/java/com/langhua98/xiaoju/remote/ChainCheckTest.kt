package com.langhua98.xiaoju.remote

import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.TimeZone

/** 新云盘（Tailscale）的 Let's Encrypt ECDSA 证书链，用 App 自带的根证书能验过（0.26）。 */
class ChainCheckTest {
    private val cf = CertificateFactory.getInstance("X.509")
    private fun load(stream: java.io.InputStream) = stream.use { cf.generateCertificates(it).map { c -> c as X509Certificate } }
    private val roots = load(File("src/main/res/raw/roots.pem").inputStream())
    private val chain = load(javaClass.classLoader!!.getResourceAsStream("tsnet-chain.pem")).toTypedArray()
    private fun at(s: String) = SimpleDateFormat("yyyy-MM-dd").apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(s)!!

    @Test fun tailscaleChainVerifies() {
        ChainCheck(roots, null).verify(chain, at("2026-12-01"))
    }

    @Test fun leafAloneIsNotEnough() {
        assertThrows(CertificateException::class.java) { ChainCheck(roots, null).verify(arrayOf(chain[0]), at("2026-12-01")) }
    }

    @Test fun unknownRootFails() {
        assertThrows(CertificateException::class.java) { ChainCheck(emptyList(), null).verify(chain, at("2026-12-01")) }
    }

    @Test fun expiredLeafFails() {
        assertThrows(CertificateException::class.java) { ChainCheck(roots, null).verify(chain, at("2027-03-01")) }
    }

    @Test fun brokenSignatureFails() {
        // 网站证书配上别人的中间证书：签名对不上
        val wrong = arrayOf(chain[0], chain[2], chain[3])
        assertThrows(CertificateException::class.java) { ChainCheck(roots, null).verify(wrong, at("2026-12-01")) }
    }
}
