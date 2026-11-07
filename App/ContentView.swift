import AVFoundation
import CoreLocation
import Speech
import SwiftUI

let brandOrange = Color(red: 1.0, green: 0.48, blue: 0.09)

struct ContentView: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var engine: RemoteEngine
    @State private var locMgr = CLLocationManager()
    @State private var showFace = false

    var body: some View {
        NavigationView {
            Form {
                Section {
                    Text("这台 iPhone 开「待命」后，等另一台设备发来的指令：拍照、录音、定位、手电筒、震动、响铃。被远程使用时屏幕会一直亮着，动作都记在下面。")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section("云盘") {
                    TextField("云盘地址", text: $store.base)
                        .textInputAutocapitalization(.never).disableAutocorrection(true)
                    SecureField("云盘令牌 xa_…", text: $store.token)
                }
                Section("这台设备") {
                    TextField("设备名，比如 测试机B", text: $store.device)
                    SecureField("配对口令（两台要一样）", text: $store.pair)
                }

                Section {
                    Button("授权硬件（相机 / 麦克风 / 定位 / 语音识别）") { requestPermissions() }
                    Button(engine.running ? "停止待命" : "开始待命") {
                        engine.running ? engine.stop() : engine.start()
                    }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(engine.running ? Color.red : brandOrange)
                } footer: {
                    Text(engine.running ? "● 待命中（设备名：\(store.device)）" : "○ 未运行")
                        .foregroundStyle(engine.running ? .green : .secondary)
                        .font(.body.weight(.semibold))
                }

                Section {
                    TextField("接口地址，比如 https://api.deepseek.com/v1", text: $store.llmBase)
                        .textInputAutocapitalization(.never).disableAutocorrection(true).keyboardType(.URL)
                    TextField("模型名，比如 deepseek-chat", text: $store.llmModel)
                        .textInputAutocapitalization(.never).disableAutocorrection(true)
                    SecureField("API 密钥", text: $store.llmKey)
                } header: {
                    Text("对话（大模型）")
                } footer: {
                    Text("支持 OpenAI 兼容接口（DeepSeek、智谱、通义、Kimi、OpenAI 等）。密钥只存在这台手机的钥匙串里。")
                }

                Section {
                    TextField("语音服务地址（空着用 iOS 自带语音）", text: $store.ttsBase)
                        .textInputAutocapitalization(.never).disableAutocorrection(true).keyboardType(.URL)
                    TextField("音色，比如 zf_088", text: $store.ttsVoice)
                        .textInputAutocapitalization(.never).disableAutocorrection(true)
                } header: {
                    Text("机器人的声音（Kokoro）")
                } footer: {
                    Text("默认用小橘视频流式服务上的 Kokoro 中文语音（女声 zf_088）。它闲了会休息，第一次说话可能要等十几秒；连不上时自动改用 iOS 自带语音。")
                }

                Section {
                    Button("打开机器人的脸") { showFace = true }
                } header: {
                    Text("机器人模式")
                } footer: {
                    Text("整个屏幕变成 Live2D 角色的脸，待命照常进行。点一下屏幕和她说话，她用大模型回答并读出来；收到遥控指令时表情会跟着变；拍照、录音、听你说话时屏幕上方会提示。连点三下退出。")
                }

                Section("记录") {
                    if engine.log.isEmpty {
                        Text("还没有动作").foregroundStyle(.secondary).font(.footnote)
                    } else {
                        ForEach(Array(engine.log.suffix(60).enumerated()), id: \.offset) { _, line in
                            Text(line).font(.system(.caption2, design: .monospaced))
                        }
                    }
                }
            }
            .navigationTitle("小橘遥控")
        }
        .navigationViewStyle(.stack)
        .tint(brandOrange)
        .fullScreenCover(isPresented: $showFace) {
            RobotModeView { showFace = false }
                .environmentObject(store)
                .environmentObject(engine)
        }
    }

    private func requestPermissions() {
        AVCaptureDevice.requestAccess(for: .video) { _ in }
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        SFSpeechRecognizer.requestAuthorization { _ in }
        locMgr.requestWhenInUseAuthorization()
    }
}
