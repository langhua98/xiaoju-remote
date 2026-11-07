#!/usr/bin/env python3
"""Yunlai Robot 面部动画的本地调试服务器（只用 Python 标准库）。

它做两件事：
1. 把 Robot/ 目录当成网站：/face/ 是 2D 眼睛版，/avatar/ 是 3D 角色版。
2. 在 /ws 上开一个 WebSocket，把你在终端里输入的指令广播给所有打开的页面。

用法：
    python3 Robot/face_server.py            # 默认端口 8765
    手机打开 http://电脑IP:8765/avatar/?ws=auto
    然后在终端输入：listening / thinking / speaking happy / gimbal -30 / event anomaly / help
"""
import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
STATES = {"idle", "listening", "thinking", "speaking", "observing"}
EMOTIONS = {"neutral", "happy", "alert", "surprised", "confused"}

clients = set()
clients_lock = threading.Lock()
send_lock = threading.Lock()


def read_exact(f, n):
    data = b""
    while len(data) < n:
        chunk = f.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def read_frame(f):
    head = read_exact(f, 2)
    if head is None:
        return None, None
    opcode = head[0] & 0x0F
    masked = head[1] & 0x80
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack(">H", read_exact(f, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", read_exact(f, 8))[0]
    mask = read_exact(f, 4) if masked else b"\0\0\0\0"
    payload = read_exact(f, length) if length else b""
    if payload is None:
        return None, None
    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload


def send_frame(conn, payload, opcode=1):
    n = len(payload)
    if n < 126:
        head = struct.pack(">BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack(">BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack(">BBQ", 0x80 | opcode, 127, n)
    with send_lock:
        conn.sendall(head + payload)


def broadcast(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with clients_lock:
        targets = list(clients)
    for c in targets:
        try:
            send_frame(c, data)
        except OSError:
            with clients_lock:
                clients.discard(c)
    return len(targets)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, fmt, *args):  # 安静一点，只在出错时说话
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/ws" and self.headers.get("Upgrade", "").lower() == "websocket":
            return self.handle_ws()
        if self.path in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/avatar/?ws=auto")
            self.end_headers()
            return
        return super().do_GET()

    def handle_ws(self):
        key = self.headers.get("Sec-WebSocket-Key", "")
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        self.send_response(101)
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        super().end_headers()
        self.wfile.flush()
        conn = self.connection
        with clients_lock:
            clients.add(conn)
        print("\n[已连接] 页面数：%d" % len(clients), flush=True)
        try:
            while True:
                op, data = read_frame(self.rfile)
                if op is None or op == 8:
                    break
                if op == 9:
                    send_frame(conn, data, 10)
                elif op == 1:
                    print("\n[页面] " + data.decode("utf-8", "replace"), flush=True)
        except OSError:
            pass
        finally:
            with clients_lock:
                clients.discard(conn)
            print("\n[断开] 页面数：%d" % len(clients), flush=True)
        self.close_connection = True


HELP = """指令：
  idle | listening | thinking | speaking | observing  [情绪]
  happy | alert | surprised | confused | neutral       只换情绪
  gaze X Y          视线（-1~1，x 右为正，y 下为正）
  mouth 0.6         嘴部开合
  gimbal YAW [PITCH]  云台角度（度，yaw 负为左）
  event NAME        boot / person_detected / voice_start / speech_end /
                    answer_start / answer_end / anomaly / idle
  sensing cam|mic on|off   显示摄像头/麦克风工作提示
  speak URL         播放一段音频，嘴型跟着音量动
  {...}             直接发一条 JSON
  quit"""


def parse(line):
    parts = line.split()
    if not parts:
        return None
    cmd, args = parts[0].lower(), parts[1:]
    if line.startswith("{"):
        return json.loads(line)
    if cmd in STATES:
        msg = {"type": "robot_state", "state": cmd}
        if args and args[0] in EMOTIONS:
            msg["emotion"] = args[0]
        return msg
    if cmd in EMOTIONS:
        return {"type": "robot_state", "emotion": cmd}
    if cmd == "gaze":
        return {"type": "robot_state", "gaze": {"x": float(args[0]), "y": float(args[1]) if len(args) > 1 else 0}}
    if cmd == "mouth":
        return {"type": "robot_state", "mouth_level": float(args[0])}
    if cmd == "gimbal":
        return {"type": "gimbal", "yaw": float(args[0]), "pitch": float(args[1]) if len(args) > 1 else 0}
    if cmd == "event":
        msg = {"type": "event", "name": args[0]}
        if len(args) >= 3:
            msg.update(x=float(args[1]), y=float(args[2]))
        return msg
    if cmd == "sensing":
        return {"type": "sensing", "camera" if args[0].startswith("cam") else "mic": args[1] == "on"}
    if cmd == "speak":
        return {"type": "speak", "url": args[0]}
    raise ValueError("看不懂：" + line)


def lan_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(ips) or ["127.0.0.1"]


def main():
    ap = argparse.ArgumentParser(description="Yunlai 面部动画调试服务器")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    for ip in lan_ips():
        print("3D 角色： http://%s:%d/avatar/?ws=auto" % (ip, a.port))
        print("2D 眼睛： http://%s:%d/face/?ws=auto" % (ip, a.port))
    print("输入 help 看指令。", flush=True)
    while True:
        try:
            line = input("> ").strip()
        except EOFError:
            # 没有终端（比如被测试脚本启动）时，保持运行
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            break
        if not line:
            continue
        if line in ("quit", "exit"):
            break
        if line == "help":
            print(HELP)
            continue
        try:
            msg = parse(line)
        except (ValueError, IndexError, json.JSONDecodeError) as e:
            print("出错：%s（输入 help 看指令）" % e)
            continue
        print("已发给 %d 个页面：%s" % (broadcast(msg), json.dumps(msg, ensure_ascii=False)))
    srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
