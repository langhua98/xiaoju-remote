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
                    TextField("接口地址（默认 DeepSeek）", text: $store.llmBase)
                        .textInputAutocapitalization(.never).disableAutocorrection(true).keyboardType(.URL)
                    Picker("模型", selection: $store.llmModel) {
                        ForEach(Store.llmModels, id: \.id) { m in Text(m.name).tag(m.id) }
                    }
                    .pickerStyle(.segmented)
                    SecureField("API 密钥", text: $store.llmKey)
                } header: {
                    Text("对话（大模型）")
                } footer: {
                    Text("默认用 DeepSeek（\(Store.defaultLLMBase)），填 DeepSeek 的 API 密钥就能用。模型二选一：deepseek-chat 回答快；deepseek-reasoner 先想再答，慢一些。填完自动保存，更新 App 不用重填（钥匙串里另存了一份）。")
                }

                GimbalSection(gimbal: engine.gimbal, auto: $store.gimbalAuto)

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
        if store.gimbalAuto { engine.gimbal.connect() }
        AVCaptureDevice.requestAccess(for: .video) { _ in }
        AVAudioSession.sharedInstance().requestRecordPermission { _ in }
        SFSpeechRecognizer.requestAuthorization { _ in }
        locMgr.requestWhenInUseAuthorization()
    }
}

/// 设置页的「云台」一栏：连接、状态、试着转一转
private struct GimbalSection: View {
    @ObservedObject var gimbal: Gimbal
    @Binding var auto: Bool

    var body: some View {
        Section {
            HStack {
                Text(gimbal.name.isEmpty ? "大疆 OM 云台" : gimbal.name)
                Spacer()
                Text(gimbal.busy ? "正在转" : gimbal.phase.rawValue)
                    .foregroundStyle(gimbal.connected ? Color.green : Color.secondary)
            }
            if gimbal.connected {
                Text(gimbal.status()).font(.footnote).foregroundStyle(.secondary)
                HStack(spacing: 18) {
                    Spacer()
                    pad("arrow.left") { gimbal.move(yawSpeed: -25, pitchSpeed: 0, seconds: 0.6) }
                    pad("arrow.up") { gimbal.move(yawSpeed: 0, pitchSpeed: 20, seconds: 0.6) }
                    pad("arrow.down") { gimbal.move(yawSpeed: 0, pitchSpeed: -20, seconds: 0.6) }
                    pad("arrow.right") { gimbal.move(yawSpeed: 25, pitchSpeed: 0, seconds: 0.6) }
                    pad("scope") { Task { _ = await gimbal.command(["action": "center"]) } }
                    Spacer()
                }
            } else if !gimbal.note.isEmpty {
                Text(gimbal.note).font(.footnote).foregroundStyle(.secondary)
            }
            Button(gimbal.connected || gimbal.phase == .scanning || gimbal.phase == .connecting ? "断开云台" : "连接云台") {
                if gimbal.phase == .off || gimbal.phase == .noBluetooth || gimbal.phase == .denied { gimbal.connect() }
                else { gimbal.disconnect() }
            }
            Toggle("打开 App 时自动连", isOn: $auto)
        } header: {
            Text("云台（大疆 OM）")
        } footer: {
            Text("把这台 iPhone 夹在大疆 OM 云台上，它就是机器人的身体：别的设备可以远程让它转头（gimbal 指令），机器人的脸也跟着云台的朝向看。用之前先在 DJI Mimo 里断开云台。箭头试着转一下，靶心回到归位点（连上时的朝向）。")
        }
    }

    private func pad(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.title3) }
            .buttonStyle(.borderless)
            .disabled(gimbal.busy)
    }
}
