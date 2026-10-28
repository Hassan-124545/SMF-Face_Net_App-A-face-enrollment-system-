import asyncio
import base64
import time

import cv2
import mediapipe as mp
import numpy as np
import requests
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from config import (
    API_KEY, APP_TOKEN, CAPTURE_DIR, CENTER_X, CENTER_Y, CROSS_TOL, ENROLL_URL,
    FRONT_PITCH, FRONT_YAW, MIN_FACE_SIZE, MIN_SHARPNESS, PITCH_DELTA, PITCH_MAX,
    REQUIRE_STABLE, STABLE_TOL, START_DELAY, SWAP_BACK, SWAP_FRONT, YAW_DELTA, YAW_MAX,
)

STEPS = [
    ("front", "Look straight at the camera"),
    ("left", "Turn your face to your LEFT"),
    ("right", "Turn your face to your RIGHT"),
    ("up", "Tilt your face UP"),
    ("bottom", "Tilt your face DOWN"),
]

ROTATIONS = [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180]

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


def face_box(lm):
    xs = [p.x for p in lm]
    ys = [p.y for p in lm]
    return min(xs), max(xs), min(ys), max(ys)


def face_sharpness(img, x0, x1, y0, y1):
    """Laplacian variance of the face area. Low value = blurry."""
    h, w = img.shape[:2]
    a, b = max(int(x0 * w), 0), min(int(x1 * w), w)
    c, d = max(int(y0 * h), 0), min(int(y1 * h), h)
    if b - a < 20 or d - c < 20:
        return 0.0
    gray = cv2.cvtColor(img[c:d, a:b], cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (200, 200))
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def get_pose(fm, jpg_bytes, rot_hint):
    """Return (pose dict or None, rotation_used). Tries rotated copies if no face is found."""
    img = cv2.imdecode(np.frombuffer(jpg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None, rot_hint
    h, w = img.shape[:2]
    scale = 640 / max(h, w)
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1 else img
    order = [rot_hint] + [r for r in ROTATIONS if r != rot_hint]
    for rot in order:
        im = small if rot is None else cv2.rotate(small, rot)
        res = fm.process(cv2.cvtColor(im, cv2.COLOR_BGR2RGB))
        if not res.multi_face_landmarks:
            continue
        # use the largest face, people in the background are ignored
        lm = max(res.multi_face_landmarks,
                 key=lambda f: face_box(f.landmark)[1] - face_box(f.landmark)[0]).landmark
        x0, x1, y0, y1 = face_box(lm)
        left_cheek, right_cheek, nose = lm[234], lm[454], lm[1]
        forehead, chin = lm[10], lm[152]
        size = abs(right_cheek.x - left_cheek.x)
        yaw = (nose.x - left_cheek.x) / (size + 1e-6)          # 0.5 = straight
        pitch = (nose.y - forehead.y) / (chin.y - forehead.y + 1e-6)
        big = img if rot is None else cv2.rotate(img, rot)
        sharp = face_sharpness(big, x0, x1, y0, y1)
        pose = {"yaw": yaw, "pitch": pitch, "size": size, "sharp": sharp, "cx": nose.x, "cy": nose.y}
        return pose, rot
    return None, rot_hint


def quality_issue(p):
    """Return a message if the photo is not good enough, otherwise None."""
    if p["size"] < MIN_FACE_SIZE:
        return "Move the phone a little closer"
    if not (CENTER_X[0] < p["cx"] < CENTER_X[1] and CENTER_Y[0] < p["cy"] < CENTER_Y[1]):
        return "Keep the face in the center of the frame"
    if p["sharp"] < MIN_SHARPNESS:
        return "Hold steady, the image is blurry"
    return None


def angle_ok(name, yaw, pitch, base):
    if name == "front":
        return FRONT_YAW[0] < yaw < FRONT_YAW[1] and FRONT_PITCH[0] < pitch < FRONT_PITCH[1]
    if base is None:
        return False
    base_yaw, base_pitch = base
    if name == "left":
        return YAW_DELTA < yaw - base_yaw < YAW_MAX and abs(pitch - base_pitch) < CROSS_TOL
    if name == "right":
        return YAW_DELTA < base_yaw - yaw < YAW_MAX and abs(pitch - base_pitch) < CROSS_TOL
    if name == "up":
        return PITCH_DELTA < base_pitch - pitch < PITCH_MAX and abs(yaw - base_yaw) < CROSS_TOL
    if name == "bottom":
        return PITCH_DELTA < pitch - base_pitch < PITCH_MAX and abs(yaw - base_yaw) < CROSS_TOL
    return False


def status(msg, got, dbg="", match=False):
    return {"type": "status", "msg": msg, "got": got, "total": len(STEPS),
            "done": got == len(STEPS), "dbg": dbg, "match": match}


def save_copies(employee_id, shots):
    folder = CAPTURE_DIR / (employee_id or "unknown")
    folder.mkdir(parents=True, exist_ok=True)
    for name, jpg in shots:
        (folder / f"{name}.jpg").write_bytes(jpg)


def send_to_api(form, shots):
    save_copies(form.get("employee_id", ""), shots)
    data = [(k, v) for k, v in form.items() if v]
    data += [("angles", name) for name, _ in shots]
    files = [("images", (f"{name}.jpg", jpg, "image/jpeg")) for name, jpg in shots]
    print("POST to:", ENROLL_URL)
    print("Sending to API:", data)
    r = requests.post(ENROLL_URL, headers={"X-API-Key": API_KEY},
                      data=data, files=files, timeout=60, allow_redirects=False)
    print("API response:", r.status_code, r.text)
    if r.is_redirect:
        target = r.headers.get("location")
        print("Redirected to:", target)
        return False, f"HTTP {r.status_code}: the server redirected to {target}. Use that URL as ENROLL_URL."
    return r.ok, f"HTTP {r.status_code}: {r.text[:500]}"


@app.websocket("/ws/enroll")
async def enroll_ws(ws: WebSocket, token: str = ""):
    if token != APP_TOKEN:
        await ws.close(code=4001)
        return
    await ws.accept()
    fm = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True, max_num_faces=3, min_detection_confidence=0.3)
    step, shots, rot, base, cand = 0, [], None, None, None
    started = time.monotonic()
    try:
        await ws.send_json(status(STEPS[0][1], 0))
        while True:
            msg = await ws.receive_json()

            if msg["type"] == "frame" and step < len(STEPS):
                instruction = STEPS[step][1]
                if time.monotonic() - started < START_DELAY:
                    await ws.send_json(status(f"Get ready...\n{instruction}", 0))
                    continue

                jpg = base64.b64decode(msg["data"])
                swap = SWAP_FRONT if msg.get("facing", "front") == "front" else SWAP_BACK
                pose, rot = await asyncio.to_thread(get_pose, fm, jpg, rot)
                if pose is None:
                    cand = None
                    await ws.send_json(status(f"Face not detected\n{instruction}", len(shots)))
                    continue

                yaw = 1 - pose["yaw"] if swap else pose["yaw"]
                pitch = pose["pitch"]
                dbg = (f"yaw={yaw:.2f} pitch={pitch:.2f} size={pose['size']:.2f} "
                       f"sharp={pose['sharp']:.0f}")

                issue = quality_issue(pose)
                if issue:
                    cand = None
                    await ws.send_json(status(f"{issue}\n{instruction}", len(shots), dbg))
                    continue

                name = STEPS[step][0]
                if not angle_ok(name, yaw, pitch, base):
                    cand = None
                    await ws.send_json(status(instruction, len(shots), dbg, False))
                    continue

                stable = (not REQUIRE_STABLE) or (
                    cand is not None
                    and abs(yaw - cand[0]) < STABLE_TOL
                    and abs(pitch - cand[1]) < STABLE_TOL)
                if stable:
                    if name == "front":
                        base = (yaw, pitch)      # reference for the other angles
                    shots.append((name, jpg))
                    step += 1
                    cand = None
                    text = STEPS[step][1] if step < len(STEPS) else "Enrollment complete"
                    await ws.send_json(status(text, len(shots), dbg, True))
                else:
                    cand = (yaw, pitch)
                    await ws.send_json(status(f"Hold still\n{instruction}", len(shots), dbg, True))

            elif msg["type"] == "submit":
                form = {k: v for k, v in msg.items() if k != "type"}
                try:
                    good, detail = await asyncio.to_thread(send_to_api, form, shots)
                except Exception as e:
                    print("API call failed:", e)
                    good, detail = False, str(e)
                await ws.send_json({"type": "result", "ok": good, "detail": detail})
    except WebSocketDisconnect:
        pass
    finally:
        fm.close()