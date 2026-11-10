package com.langhua98.xiaoju.remote

import android.content.Context
import java.io.File

/**
 * 闪退记录：App 崩了就把原因写到文件里，下次打开时显示在日志最上面（S4 上看不到系统日志，靠这个知道哪里崩了）。
 */
object CrashLog {
    @Volatile private var installed = false

    fun install(ctx: Context) {
        if (installed) return
        installed = true
        val file = File(ctx.applicationContext.filesDir, "crash.txt")
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { t, e ->
            runCatching {
                val trace = android.util.Log.getStackTraceString(e).lineSequence().take(25).joinToString("\n")
                file.writeText("${BuildConfig.VERSION_NAME}（构建 ${BuildConfig.BUILD_NUMBER}）线程 ${t.name}：\n$trace")
            }
            previous?.uncaughtException(t, e)
        }
    }

    /** 上次闪退的记录（读完就删），没有返回 null。 */
    fun take(ctx: Context): String? {
        val file = File(ctx.applicationContext.filesDir, "crash.txt")
        if (!file.exists()) return null
        return runCatching { file.readText() }.getOrNull().also { file.delete() }
    }
}
