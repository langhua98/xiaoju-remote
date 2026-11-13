# 视频 → 每帧 33 个 3D 关键点（MediaPipe Pose，世界坐标，米，以胯中心为原点）
import sys, json
import cv2, numpy as np
import mediapipe as mp
from mediapipe.tasks import python as mpt
from mediapipe.tasks.python import vision

video, model, out = sys.argv[1], sys.argv[2], sys.argv[3]
opts = vision.PoseLandmarkerOptions(
    base_options=mpt.BaseOptions(model_asset_path=model),
    running_mode=vision.RunningMode.VIDEO, num_poses=1,
    min_pose_detection_confidence=0.3, min_pose_presence_confidence=0.3, min_tracking_confidence=0.3)
cap = cv2.VideoCapture(video)
fps = cap.get(cv2.CAP_PROP_FPS) or 24
frames = []
img = None
with vision.PoseLandmarker.create_from_options(opts) as lm:
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok: break
        img = frame
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        r = lm.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int(i * 1000 / fps))
        if r.pose_world_landmarks:
            w = [[p.x, p.y, p.z, p.visibility] for p in r.pose_world_landmarks[0]]
            n = [[p.x, p.y, p.z] for p in r.pose_landmarks[0]]
            frames.append({'w': w, 'n': n})
        else:
            frames.append(None)
        i += 1
json.dump({'fps': fps, 'w': img.shape[1] if frames else 0, 'h': img.shape[0] if frames else 0, 'frames': frames}, open(out, 'w'))
print('frames', len(frames), 'detected', sum(f is not None for f in frames), 'fps', fps)
