package com.langhua98.xiaoju.remote

import android.Manifest
import android.annotation.TargetApi
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.RadioGroup
import android.widget.TextView

/**
 * 设置界面：设备名（A～D）、配对口令（默认 0）、授权、待命开关、检查更新、记录。只用系统自带控件，4.2 也能跑。
 * 云盘地址固定，令牌编译时打进 App（本地编、没带令牌的包才显示令牌框）。自动更新一直开着。
 */
class MainActivity : Activity() {

    private lateinit var token: EditText
    private lateinit var device: RadioGroup
    private lateinit var pair: EditText
    private lateinit var toggle: Button
    private lateinit var status: TextView
    private lateinit var log: TextView
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.install(this)
        CrashLog.take(this)?.let { Bus.push("上次闪退了，原因（截图发给 Claude）：\n$it") }
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        token = findViewById(R.id.token)
        device = findViewById(R.id.device)
        pair = findViewById(R.id.pair)
        toggle = findViewById(R.id.toggle)
        status = findViewById(R.id.status)
        log = findViewById(R.id.log)

        if (BuildConfig.CLOUD_TOKEN.isBlank()) {
            findViewById<android.view.View>(R.id.tokenRow).visibility = android.view.View.VISIBLE
            token.setText(prefs.token)
        }
        device.check(DEVICE_IDS[Prefs.DEVICES.indexOf(prefs.device).coerceAtLeast(0)])
        pair.setText(prefs.pair)

        findViewById<Button>(R.id.perms).setOnClickListener { requestPerms() }
        toggle.setOnClickListener { onToggle() }
        findViewById<TextView>(R.id.version).text =
            "现在是 ${Updater.currentLabel(this)}。自动更新：待命时每 6 小时看一次云盘「软件包」，有新版本就下载；" +
            "有 root 直接装，没有 root 要点一下「安装」。"
        findViewById<Button>(R.id.update).setOnClickListener { b -> checkUpdate(b as Button) }

        Bus.onLog = { lines -> log.text = lines.takeLast(80).joinToString("\n"); refresh() }
        log.text = Bus.snapshot().takeLast(80).joinToString("\n")
        refresh()
    }

    override fun onResume() { super.onResume(); refresh() }
    override fun onDestroy() { Bus.onLog = null; super.onDestroy() }

    private fun save() {
        if (BuildConfig.CLOUD_TOKEN.isBlank()) prefs.token = token.text.toString()
        prefs.device = Prefs.DEVICES.getOrElse(DEVICE_IDS.indexOf(device.checkedRadioButtonId)) { Prefs.DEVICES[0] }
        // 口令清空了就回到默认的 0
        prefs.pair = pair.text.toString().trim().ifEmpty { Prefs.DEFAULT_PAIR }
        pair.setText(prefs.pair)
    }

    private fun refresh() {
        status.text = if (Bus.running) "● 待命中（设备名：${prefs.device}）" else "○ 未运行"
        toggle.text = if (Bus.running) "停止待命" else "开始待命"
    }

    private fun onToggle() {
        save()
        if (Bus.running) { RemoteService.stop(this); toggle.postDelayed({ refresh() }, 400); return }
        if (prefs.token.isBlank()) { Bus.push("先填云盘令牌"); return }
        toggle.isEnabled = false
        Bus.push("连接云盘…")
        // 先测一下能不能连上，再启动服务
        Thread {
            val err = try { Net.init(this); Cloud(prefs.base, prefs.token).me(); null } catch (e: Exception) { e.message ?: e.javaClass.simpleName }
            runOnUiThread {
                toggle.isEnabled = true
                if (err == null) { RemoteService.start(this); toggle.postDelayed({ refresh() }, 400) }
                else Bus.push("连不上，没启动：$err")
            }
        }.start()
    }

    /** 用户点「检查更新」：查云盘，有新的就下载，弹安装界面（有 root 直接装）。 */
    private fun checkUpdate(b: Button) {
        save()
        if (prefs.token.isBlank()) { Bus.push("先填云盘令牌"); return }
        b.isEnabled = false
        Bus.push("查更新…")
        Thread({
            try {
                Net.init(this)
                val u = Updater(applicationContext, prefs.base, prefs.token)
                val r = u.prepare()
                Bus.push(r.text)
                if (r.file != null) {
                    r.pkg?.let { prefs.updatePrompted = it.name }
                    Bus.push(u.plan(fromUi = true))
                    u.install(r, this)   // 用 root 装要等一会儿，留在后台线程（startActivity 在哪个线程都行）
                }
            } catch (e: Exception) {
                Bus.push("查更新出错：${e.message ?: e.javaClass.simpleName}")
            }
            runOnUiThread { b.isEnabled = true }
        }, "update").start()
    }

    private fun requestPerms() {
        if (Build.VERSION.SDK_INT < 23) { Bus.push("这个系统版本装 App 时就授权了，不用再点"); return }
        PermsApi23.request(this)
    }
}

/** 设备名 A～D 对应的单选按钮 */
private val DEVICE_IDS = listOf(R.id.devA, R.id.devB, R.id.devC, R.id.devD)

@TargetApi(23)
private object PermsApi23 {
    fun request(a: Activity) {
        val perms = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) perms.add("android.permission.POST_NOTIFICATIONS")
        a.requestPermissions(perms.toTypedArray(), 1)
    }
}
