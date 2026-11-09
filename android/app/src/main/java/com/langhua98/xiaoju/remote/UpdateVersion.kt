package com.langhua98.xiaoju.remote

/**
 * 自动更新里不碰安卓的部分（可以在电脑上跑测试）：从云盘「软件包」的文件名认出版本，比新旧。
 *
 * workflow 传到云盘的安装包叫 `xiaoju-remote-android-<版本>-build<构建号>.apk`，比如
 * `xiaoju-remote-android-0.19-build57.apk`。构建号就是 GitHub 的 run_number，编译时也写进了 App（BuildConfig.BUILD_NUMBER），
 * 所以同一个版本号重编一次（构建号变大）也算新的。
 */
object UpdateVersion {
    const val PREFIX = "xiaoju-remote-android-"
    private val NAME = Regex("^xiaoju-remote-android-([0-9]+(?:\\.[0-9]+)*)-build([0-9]{1,9})\\.apk$")

    data class Pkg(val name: String, val version: String, val build: Int) {
        val label get() = "$version（构建 $build）"
    }

    /** 认不出来的文件名返回 null（别的软件、手动传的包都不管）。 */
    fun parse(name: String): Pkg? {
        val m = NAME.matchEntire(name) ?: return null
        val build = m.groupValues[2].toIntOrNull() ?: return null
        return Pkg(name, m.groupValues[1], build)
    }

    /** 比版本号：0.9 < 0.10 < 0.18 < 1.0，按点分开一段段比数字，少的一段当 0。 */
    fun compareVersion(a: String, b: String): Int {
        val x = a.split('.').map { it.toIntOrNull() ?: 0 }
        val y = b.split('.').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val c = (x.getOrElse(i) { 0 }).compareTo(y.getOrElse(i) { 0 })
            if (c != 0) return c
        }
        return 0
    }

    /** p 比手机上装的（version、build）新吗？版本号大就新；版本号一样，构建号大就新。 */
    fun isNewer(p: Pkg, version: String, build: Int): Boolean {
        val c = compareVersion(p.version, version)
        return if (c != 0) c > 0 else p.build > build
    }

    /** 一堆文件名里最新的那个安装包，没有返回 null。 */
    fun newest(names: Collection<String>): Pkg? =
        names.mapNotNull { parse(it) }.maxWithOrNull(Comparator { a, b ->
            val c = compareVersion(a.version, b.version)
            if (c != 0) c else a.build.compareTo(b.build)
        })
}
