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
 * 0.38 起界面上只有一个大按钮：开始 / 停止待命（William 要求）。点开始时缺授权就先弹授权。
 * 设置都还在，藏起来了：长按按钮打开（设备名 A～D、配对口令、授权、检查更新、允许远程跑命令、运行记录）。
 * 只用系统自带控件，4.2 也能跑。云盘地址固定，令牌编译时打进 App（本地编、没带令牌的包，点开始会自动打开设置填令牌）。
 */
class MainActivity : Activity() {

    private lateinit var token: EditText
    private lateinit var device: RadioGroup
    private lateinit var pair: EditText
    private lateinit var toggle: Button
    private lateinit var status: TextView
    private lateinit var log: TextView
    private lateinit var prefs: Prefs
    private lateinit var settings: android.view.View
    /** 点了开始、正在等授权弹窗回来 */
    private var startAfterPerms = false
    /** 这次打开 App 已经弹过授权了（不给也不再弹，照样启动，缺的功能回执里会说） */
    private var permsAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CrashLog.install(this)
        Bus.init(this)
        CrashLog.take(this)?.let { Bus.push("上次闪退了，原因（截图发给 Claude）：\n$it") }
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        token = findViewById(R.id.token)
        device = findViewById(R.id.device)
        pair = findViewById(R.id.pair)
        toggle = findViewById(R.id.toggle)
        status = findViewById(R.id.status)
        log = findViewById(R.id.log)
        settings = findViewById(R.id.settings)

        if (BuildConfig.CLOUD_TOKEN.isBlank()) {
            findViewById<android.view.View>(R.id.tokenRow).visibility = android.view.View.VISIBLE
            token.setText(prefs.token)
        }
        device.check(DEVICE_IDS[Prefs.DEVICES.indexOf(prefs.device).coerceAtLeast(0)])
        pair.setText(prefs.pair)

        findViewById<Button>(R.id.perms).setOnClickListener { requestPerms() }
        toggle.setOnClickListener { onToggle() }
        toggle.setOnLongClickListener { showSettings(true); true }
        findViewById<Button>(R.id.hideSettings).setOnClickListener { save(); showSettings(false) }
        findViewById<TextView>(R.id.version).text =
            "现在是 ${Updater.currentLabel(this)}。自动更新：待命时每 6 小时看一次云盘「软件包」，有新版本就下载；" +
            "有 root 直接装，没有 root 要点一下「安装」。"
        findViewById<Button>(R.id.update).setOnClickListener { b -> checkUpdate(b as Button) }
        findViewById<android.widget.CheckBox>(R.id.allowShell).apply {
            isChecked = prefs.allowShell
            setOnCheckedChangeListener { _, on ->
                prefs.allowShell = on
                Bus.push(if (on) "已允许远程跑命令（用完记得关掉）" else "已关掉远程跑命令")
            }
        }

        Bus.onLog = { lines -> log.text = lines.takeLast(80).joinToString("\n"); refresh() }
        log.text = Bus.snapshot().takeLast(80).joinToString("\n")
        refresh()
        // 0.39：打开 App 就自己待命（没点过「停止」的话），不用手点。系统安装界面装完点「打开」也算
        if (prefs.standby && !Bus.running && prefs.token.isNotBlank()) {
            Bus.push("自动开始待命")
            RemoteService.start(this)
            toggle.postDelayed({ refresh() }, 400)
        }
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
        toggle.text = if (Bus.running) "待命中\n点一下停止" else "开始待命"
    }

    private fun showSettings(on: Boolean) {
        settings.visibility = if (on) android.view.View.VISIBLE else android.view.View.GONE
        toggle.visibility = if (on) android.view.View.GONE else android.view.View.VISIBLE
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (settings.visibility == android.view.View.VISIBLE) { save(); showSettings(false) } else super.onBackPressed()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (startAfterPerms) { startAfterPerms = false; onToggle() }   // 授权完（给没给都行）接着启动
    }

    private fun onToggle() {
        save()
        if (Bus.running) { RemoteService.stop(this); toggle.postDelayed({ refresh() }, 400); return }
        if (prefs.token.isBlank()) { Bus.push("先填云盘令牌"); showSettings(true); return }
        // 第一次点开始：缺相机、麦克风、定位授权就先弹出来（以前要点「授权硬件」）
        if (!permsAsked && Build.VERSION.SDK_INT >= 23 && PermsApi23.missing(this)) {
            permsAsked = true
            startAfterPerms = true
            PermsApi23.request(this)
            return
        }
        toggle.isEnabled = false
        toggle.text = "连接中…"
        Bus.push("连接云盘…")
        // 先测一下能不能连上，再启动服务
        Thread {
            val err = try { Net.init(this); Cloud(prefs.base, prefs.token).me(); null } catch (e: Exception) { e.message ?: e.javaClass.simpleName }
            runOnUiThread {
                toggle.isEnabled = true
                if (err == null) { RemoteService.start(this); toggle.postDelayed({ refresh() }, 400) }
                else {
                    Bus.push("连不上，没启动：$err")
                    refresh()
                    // 只有一个按钮，看不到运行记录：连不上要直接告诉人
                    android.widget.Toast.makeText(this, "连不上云盘，没启动：$err", android.widget.Toast.LENGTH_LONG).show()
                }
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
    fun missing(a: Activity): Boolean = listOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO,
        Manifest.permission.ACCESS_FINE_LOCATION).any { a.checkSelfPermission(it) != android.content.pm.PackageManager.PERMISSION_GRANTED }

    fun request(a: Activity) {
        val perms = mutableListOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 33) perms.add("android.permission.POST_NOTIFICATIONS")
        a.requestPermissions(perms.toTypedArray(), 1)
    }
}
