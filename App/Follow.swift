import AVFoundation
import Foundation
import Vision

/// 跟着人转：前摄在手机本地找人脸（系统自带的 Vision，不联网），人偏离画面中间就让云台慢慢跟过去。
/// 这是本地的反射动作，不经过大模型；大模型只负责开和关（gimbal 工具的 follow_on / follow_off，标签 [跟着我] [别跟了]）。
/// 见 Robot/GIMBAL_MODEL_PLAN.md 的 0.9。
///
/// - 默认是关的，每次打开 App 都要重新开（设置页的开关、聊天框「跟着我」、或者她自己开）。
/// - 开着的时候屏幕上方一直显示「摄像头」的提示。画面只在手机里算人脸的位置，不保存、不上传。
/// - 优先级最低：主人手动、遥控端、大模型让云台转的时候，这里让开，几秒以后再接着跟。
/// - 手机竖着夹在云台上用。左右、上下哪边是正，第一次用会自己试出来（越转离得越远就反过来），记在手机上。
final class FaceFollower: NSObject, ObservableObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    enum Phase: String {
        case off = "没开", starting = "正在打开摄像头", searching = "在找人", following = "跟着人"
        case noCamera = "摄像头打不开", denied = "没有相机权限", noGimbal = "云台没连上"
    }
    @Published private(set) var phase: Phase = .off

    // 手感参数，按真机反馈调
    /// 多久看一帧（秒）
    static let every = 0.18
    /// 人脸离中间多少度以内不动（左右、上下）；回到一半以内才停，免得在边上来回抖
    static let dead = [5.0, 6.0]
    /// 偏 1 度转多快（度每秒）、最慢、最快
    static let gain = 1.2, minSpeed = 5.0, maxSpeed = 40.0
    /// 人脸中心想放在画面的哪里（从下往上 0～1）：比正中高一点
    static let aimY = 0.56
    /// 多久看不到人就回正（秒）
    static let recenterAfter = 10.0

    /// 摄像头开了 / 关了（给屏幕上的提示用）
    var onSensing: ((Bool) -> Void)?
    var onLog: ((String) -> Void)?

    private let gimbal: Gimbal
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "vania.follow.camera")
    private let d = UserDefaults.standard

    // 下面这几个只在 queue 上用
    private var configured = false
    private var lastFrame = Date.distantPast
    private var fov = [48.0, 62.0]   // 竖屏时画面左右、上下各看多少度（打开摄像头时按镜头算）

    // 下面这些只在主线程用
    private var wanted = false
    private var lastSeen = Date.distantPast
    private var recentered = true
    private var moving = [false, false]
    private var flip = [1.0, 1.0]        // 左右、上下的正负（自己试出来的）
    private var grow = [0, 0]            // 连着几帧越转离得越远
    private var prevErr = [0.0, 0.0]
    private var sensingTimer: Timer?

    init(gimbal: Gimbal) {
        self.gimbal = gimbal
        super.init()
        if d.bool(forKey: "followFlip.0") { flip[0] = -1 }
        if d.bool(forKey: "followFlip.1") { flip[1] = -1 }
    }

    var running: Bool { wanted }

    /// 能不能开。不能的话返回原因
    func blocker() -> String? {
        if !gimbal.connected { return "云台没连上，跟不了（请主人在设置页点「连接云台」）。" }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .denied, .restricted: return "没有相机权限，跟不了（请主人在 设置 → Vania 里打开相机）。"
        default: return nil
        }
    }

    // MARK: 开关（主线程调用）

    func start() {
        guard !wanted else { return }
        wanted = true
        phase = .starting
        lastSeen = .distantPast; recentered = true
        moving = [false, false]; grow = [0, 0]
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            open()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
                DispatchQueue.main.async {
                    guard let self = self, self.wanted else { return }
                    if ok { self.open() } else { self.fail(.denied) }
                }
            }
        default:
            fail(.denied)
        }
    }

    func stop() {
        guard wanted else { return }
        wanted = false
        sensingTimer?.invalidate(); sensingTimer = nil
        let s = session
        queue.async { if s.isRunning { s.stopRunning() } }
        if moving[0] || moving[1] { _ = gimbal.track(right: 0, up: 0) }
        moving = [false, false]
        phase = .off
        onSensing?(false)
        onLog?("跟随：关了")
    }

    private func fail(_ p: Phase) {
        wanted = false
        sensingTimer?.invalidate(); sensingTimer = nil
        phase = p
        onSensing?(false)
        onLog?("跟随：\(p.rawValue)")
    }

    private func open() {
        onSensing?(true)
        // 别的指令做完会把屏幕上的提示清掉，所以隔一会儿重新亮一次
        sensingTimer?.invalidate()
        sensingTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self, self.wanted else { return }
            self.onSensing?(true)
        }
        queue.async { [weak self] in
            guard let self = self else { return }
            let ok = self.configure()
            if ok { self.session.startRunning() }
            DispatchQueue.main.async {
                guard self.wanted else { return }
                if ok { self.phase = .searching; self.onLog?("跟随：开了，在用前摄找人脸") } else { self.fail(.noCamera) }
            }
        }
    }

    /// 在 queue 上调用。只配一次
    private func configure() -> Bool {
        if configured { return true }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        if session.canSetSessionPreset(.vga640x480) { session.sessionPreset = .vga640x480 }
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else { return false }
        session.addInput(input)
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { return false }
        session.addOutput(output)
        if let c = output.connection(with: .video), c.isVideoOrientationSupported { c.videoOrientation = .portrait }
        // 镜头给的是长边的视角；竖屏时长边是上下，左右按画面的宽高比换算
        let long = Double(device.activeFormat.videoFieldOfView)
        let dim = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        let w = Double(max(dim.width, dim.height)), h = Double(min(dim.width, dim.height))
        if long > 20, w > 0, h > 0 {
            let short = 2 * atan(tan(long * .pi / 360) * h / w) * 180 / .pi
            fov = [short, long]
        }
        configured = true
        return true
    }

    // MARK: 每一帧（在 queue 上）

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = Date()
        guard now.timeIntervalSince(lastFrame) >= Self.every else { return }
        lastFrame = now
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let request = VNDetectFaceRectanglesRequest()
        let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: .up, options: [:])
        try? handler.perform([request])
        // 最大的那张脸（离得最近的人）。方框是 0～1 的比例，原点在左下角
        var best: CGRect?
        for f in request.results ?? [] {
            let b = f.boundingBox
            if best == nil || b.width * b.height > best!.width * best!.height { best = b }
        }
        let view = fov
        DispatchQueue.main.async { [weak self] in self?.step(face: best, fov: view) }
    }

    // MARK: 控制（主线程）

    private func step(face: CGRect?, fov: [Double]) {
        guard wanted else { return }
        let now = Date()
        guard gimbal.connected else {
            if phase != .noGimbal { phase = .noGimbal }
            moving = [false, false]
            return
        }
        guard let box = face else {
            if moving[0] || moving[1] { _ = gimbal.track(right: 0, up: 0) }
            moving = [false, false]; grow = [0, 0]
            if phase != .searching { phase = .searching }
            // 很久看不到人：回正面等着
            if !recentered, now.timeIntervalSince(lastSeen) > Self.recenterAfter {
                recentered = true
                let g = gimbal
                Task { @MainActor in _ = await g.aim(right: 0, up: 0, relative: false, by: .follow) }
            }
            return
        }
        lastSeen = now; recentered = false
        if phase != .following { phase = .following }

        // 人脸中心离想放的位置差多少度
        let err = [(Double(box.midX) - 0.5) * fov[0], (Double(box.midY) - Self.aimY) * fov[1]]
        var cmd = [0.0, 0.0]
        for i in 0..<2 {
            let e = err[i]
            if moving[i] {
                if abs(e) < Self.dead[i] * 0.5 { moving[i] = false }
            } else if abs(e) > Self.dead[i] {
                moving[i] = true; grow[i] = 0
            }
            if moving[i] {
                let speed = min(Self.maxSpeed, max(Self.minSpeed, abs(e) * Self.gain))
                cmd[i] = (e > 0 ? 1 : -1) * speed * flip[i]
                // 方向对不对：连着几帧越转离得越远，就是反了
                if abs(e) > abs(prevErr[i]) + 1.0 { grow[i] += 1 } else if abs(e) < abs(prevErr[i]) - 0.5 { grow[i] = 0 }
            }
            prevErr[i] = e
        }
        guard let applied = gimbal.track(right: cmd[0], up: cmd[1]) else {
            // 别人正在让云台转（或者刚转完）：让开，等会儿再跟
            moving = [false, false]; grow = [0, 0]
            return
        }
        for i in 0..<2 {
            let did = i == 0 ? applied.right : applied.up
            if cmd[i] != 0, did == 0 { grow[i] = 0; continue }   // 到限位了，不是方向反了
            if grow[i] >= 4 {
                flip[i] = -flip[i]; grow[i] = 0
                d.set(flip[i] < 0, forKey: "followFlip.\(i)")
                onLog?("跟随：\(i == 0 ? "左右" : "上下")方向反了，已改过来")
            }
        }
    }
}
