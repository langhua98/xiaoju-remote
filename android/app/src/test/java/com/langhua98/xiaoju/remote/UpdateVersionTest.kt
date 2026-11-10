package com.langhua98.xiaoju.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateVersionTest {
    @Test fun parsesWorkflowFileNames() {
        val p = UpdateVersion.parse("xiaoju-remote-android-0.19-build57.apk")!!
        assertEquals("0.19", p.version)
        assertEquals(57, p.build)
        // 别的软件、手动改过名的、不是 apk 的都不认
        assertNull(UpdateVersion.parse("XiaojuPipe-0.2-build14.ipa"))
        assertNull(UpdateVersion.parse("xiaoju-remote-latest.apk"))
        assertNull(UpdateVersion.parse("xiaoju-remote-android-0.19.apk"))
        assertNull(UpdateVersion.parse("xiaoju-remote-android-0.19-build57.apk.part"))
        assertNull(UpdateVersion.parse("xiaoju-remote-android-abc-build1.apk"))
        assertNull(UpdateVersion.parse("xiaoju-remote-android-0.19-build99999999999.apk"))
    }

    @Test fun comparesVersionsAsNumbers() {
        assertTrue(UpdateVersion.compareVersion("0.10", "0.9") > 0)
        assertTrue(UpdateVersion.compareVersion("0.19", "0.18") > 0)
        assertTrue(UpdateVersion.compareVersion("1.0", "0.99") > 0)
        assertEquals(0, UpdateVersion.compareVersion("0.19", "0.19.0"))
        assertTrue(UpdateVersion.compareVersion("0.19.1", "0.19") > 0)
    }

    @Test fun newerByVersionThenBuild() {
        val p = UpdateVersion.parse("xiaoju-remote-android-0.19-build57.apk")!!
        assertTrue(UpdateVersion.isNewer(p, "0.18", 100))   // 版本号大就新，不管构建号
        assertTrue(UpdateVersion.isNewer(p, "0.19", 56))    // 同一个版本重编了
        assertTrue(UpdateVersion.isNewer(p, "0.19", 0))     // 手机上是本地编的
        assertFalse(UpdateVersion.isNewer(p, "0.19", 57))   // 就是这个
        assertFalse(UpdateVersion.isNewer(p, "0.20", 1))    // 手机上的更新
    }

    @Test fun picksNewestPackage() {
        val names = listOf("XiaojuPush-1.2-build3.ipa", "xiaoju-remote-android-0.9-build80.apk",
            "xiaoju-remote-android-0.19-build57.apk", "xiaoju-remote-android-0.19-build60.apk",
            "xiaoju-remote-android-0.18-build99.apk")
        assertEquals("xiaoju-remote-android-0.19-build60.apk", UpdateVersion.newest(names)!!.name)
        assertNull(UpdateVersion.newest(listOf("readme.txt")))
    }
}
