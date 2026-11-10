package com.langhua98.xiaoju.remote

import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * 备用通道（ntfy.sh）的加密，三端（安卓被控端、小橘推送、遥控.py）一样算。只用 HMAC-SHA256，
 * 因为 Python 标准库没有 AES，HMAC 哪边都有。不碰安卓的类，可以在电脑上跑测试。
 *
 * 密钥 key：32 字节，手机第一次开待命时随机生成，云盘正常时存到云盘给控制端取（见 BackupChannel）。
 *   加密用的 enc = HMAC(key, "xj-enc")，校验用的 mac = HMAC(key, "xj-mac")。
 * 封一条（seal）：nonce（16 字节随机）‖ 密文 ‖ tag（32 字节）
 *   密文 = 明文 XOR 密钥流，密钥流第 i 块（32 字节）= HMAC(enc, nonce ‖ i 的 4 字节大端)
 *   tag = HMAC(mac, nonce ‖ 密文)
 * 放进 ntfy 消息正文时写成 "xj1." + base64（标准字母表，带 =）。
 * 信箱名（ntfy 的 topic）：指令 "xj" + hex(HMAC(key, "xj-topic/<设备名>/cmd")) 的前 30 位，回执把 cmd 换成 reply。
 * 不知道密钥的人既猜不到信箱名，也看不懂、改不了内容。
 */
object BackupCrypto {
    const val PREFIX = "xj1."
    private const val NONCE = 16
    private const val TAG = 32

    fun hmac(key: ByteArray, vararg parts: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(key, "HmacSHA256"))
        for (p in parts) m.update(p)
        return m.doFinal()
    }

    private fun hmac(key: ByteArray, s: String) = hmac(key, s.toByteArray(Charsets.UTF_8))

    fun newKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }

    fun topic(key: ByteArray, device: String, dir: String): String =
        "xj" + hex(hmac(key, "xj-topic/$device/$dir")).substring(0, 30)

    fun seal(key: ByteArray, plain: ByteArray, nonce: ByteArray = ByteArray(NONCE).also { SecureRandom().nextBytes(it) }): ByteArray {
        require(nonce.size == NONCE)
        val ct = xorStream(hmac(key, "xj-enc"), nonce, plain)
        val tag = hmac(hmac(key, "xj-mac"), nonce, ct)
        return nonce + ct + tag
    }

    /** 解开一条；不是用这个密钥封的、被改过的，返回 null。 */
    fun open(key: ByteArray, sealed: ByteArray): ByteArray? {
        if (sealed.size < NONCE + TAG) return null
        val nonce = sealed.copyOfRange(0, NONCE)
        val ct = sealed.copyOfRange(NONCE, sealed.size - TAG)
        val tag = sealed.copyOfRange(sealed.size - TAG, sealed.size)
        if (!MessageDigest.isEqual(tag, hmac(hmac(key, "xj-mac"), nonce, ct))) return null
        return xorStream(hmac(key, "xj-enc"), nonce, ct)
    }

    fun sealText(key: ByteArray, plain: String): String = PREFIX + b64(seal(key, plain.toByteArray(Charsets.UTF_8)))

    fun openText(key: ByteArray, text: String): String? {
        if (!text.startsWith(PREFIX)) return null
        val raw = unb64(text.substring(PREFIX.length).trim()) ?: return null
        return open(key, raw)?.toString(Charsets.UTF_8)
    }

    private fun xorStream(enc: ByteArray, nonce: ByteArray, data: ByteArray): ByteArray {
        val m = Mac.getInstance("HmacSHA256")
        m.init(SecretKeySpec(enc, "HmacSHA256"))
        val out = ByteArray(data.size)
        val ctr = ByteArray(4)
        var block = 0
        var off = 0
        while (off < data.size) {
            ctr[0] = (block ushr 24).toByte(); ctr[1] = (block ushr 16).toByte()
            ctr[2] = (block ushr 8).toByte(); ctr[3] = block.toByte()
            m.update(nonce); m.update(ctr)
            val ks = m.doFinal()   // doFinal 之后 Mac 回到刚 init 的样子，可以接着用
            val n = minOf(32, data.size - off)
            for (i in 0 until n) out[off + i] = (data[off + i].toInt() xor ks[i].toInt()).toByte()
            off += n; block++
        }
        return out
    }

    fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) { val v = x.toInt() and 0xff; sb.append("0123456789abcdef"[v ushr 4]).append("0123456789abcdef"[v and 15]) }
        return sb.toString()
    }

    // Android 8 以前没有 java.util.Base64；android.util.Base64 又不能在电脑上测，自己写一个
    private const val ABC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

    fun b64(b: ByteArray): String {
        val sb = StringBuilder((b.size + 2) / 3 * 4)
        var i = 0
        while (i < b.size) {
            val n = minOf(3, b.size - i)
            val v = ((b[i].toInt() and 0xff) shl 16) or
                    ((if (n > 1) b[i + 1].toInt() and 0xff else 0) shl 8) or
                    (if (n > 2) b[i + 2].toInt() and 0xff else 0)
            sb.append(ABC[v ushr 18 and 63]).append(ABC[v ushr 12 and 63])
            sb.append(if (n > 1) ABC[v ushr 6 and 63] else '=')
            sb.append(if (n > 2) ABC[v and 63] else '=')
            i += 3
        }
        return sb.toString()
    }

    fun unb64(s: String): ByteArray? {
        val clean = s.filter { !it.isWhitespace() }.trimEnd('=')
        val out = java.io.ByteArrayOutputStream(clean.length * 3 / 4)
        var acc = 0; var bits = 0
        for (c in clean) {
            val v = ABC.indexOf(c)
            if (v < 0) return null
            acc = (acc shl 6) or v; bits += 6
            if (bits >= 8) { bits -= 8; out.write((acc ushr bits) and 0xff) }
        }
        return out.toByteArray()
    }
}
