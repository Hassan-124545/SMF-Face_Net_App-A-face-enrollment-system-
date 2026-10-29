import asyncio
import base64
import math
import re
import time

import cv2
import mediapipe as mp
import numpy as np
import requests
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from config import (
    API_KEY, APP_TOKEN, CAPTURE_DIR, CENTER_X, CENTER_Y, CROP_FACES, CROP_MARGIN,
    CROP_MAX_SIZE, CROSS_TOL, ENROLL_URL, FRONT_PITCH, FRONT_YAW, MAX_BRIGHT, MAX_RETRIES,
    MAX_ROLL, MIN_BRIGHT, MIN_EYE_OPEN, MIN_FACE_CONF, MIN_FACE_SIZE, MIN_SHARPNESS,
    PHOTO_MIN_CONF, PITCH_DELTA, PITCH_MAX, REQUIRE_STABLE, SHARP_RATIO, STABLE_TOL,
    START_DELAY, SWAP_BACK, SWAP_FRONT, VERIFY_TRIES, YAW_DELTA, YAW_MAX,
)

STEPS = [
    ("front", "Look straight at the camera"),
    ("left", "Turn your face to your LEFT"),
    ("right", "Turn your face to your RIGHT"),
    ("up", "Tilt UP, keep eyes on the camera"),
    ("bottom", "Tilt DOWN, keep eyes on the camera"),
]
STEP_NAMES = [s[0] for s in STEPS]

ROTATIONS = [None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_180]
LEFT_EYE = (33, 160, 158, 133, 153, 144)
RIGHT_EYE = (362, 385, 387, 263, 373, 380)
EDGE = 0.01  # the whole face must stay at least this far from the photo border

app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


def face_box(lm):
    xs = [p.x for p in lm]
    ys = [p.y for p in lm]
    return min(xs), max(xs), min(ys), max(ys)


def face_stats(img, box):
    """Return (sharpness, brightness) of the face area. Low sharpness = blurry."""
    x0, x1, y0, y1 = box
    h, w = img.shape[:2]
    a, b = max(int(x0 * w), 0), min(int(x1 * w), w)
    c, d = max(int(y0 * h), 0), min(int(y1 * h), h)
    if b - a < 20 or d - c < 20:
        return 0.0, 0.0
    gray = cv2.cvtColor(img[c:d, a:b], cv2.COLOR_BGR2GRAY)
    gray = cv2.resize(gray, (200, 200), interpolation=cv2.INTER_AREA)
    sharp = float(cv2.Laplacian(cv2.GaussianBlur(gray, (3, 3), 0), cv2.CV_64F).var())
    return sharp, float(gray.mean())


def eye_open(pt, ids):
    p1, p2, p3, p4, p5, p6 = (pt(i) for i in ids)
    return (math.dist(p2, p6) + math.dist(p3, p5)) / (2 * math.dist(p1, p4) + 1e-6)


def detection_score(fd, rgb, box):
    """Confidence of the separate face detector for the face found by the mesh."""
    res = fd.process(rgb)
    if not res.detections:
        return 0.0
    x0, x1, y0, y1 = box
    best = 0.0
    for d in res.detections:
        b = d.location_data.relative_bounding_box
        cx, cy = b.xmin + b.width / 2, b.ymin + b.height / 2
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            best = max(best, d.score[0])
    return float(best)


def analyze(fm, fd, jpg_bytes, rot_hint):
    """Return (result dict or None, rotation_used). Tries rotated copies if no face is found."""
    img = cv2.imdecode(np.frombuffer(jpg_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None, rot_hint
    h, w = img.shape[:2]
    scale = 640 / max(h, w)
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1 else img
    order = [rot_hint] + [r for r in ROTATIONS if r != rot_hint]
    for rot in order:
        im = small if rot is None else cv2.rotate(small, rot)
        rgb = cv2.cvtColor(im, cv2.COLOR_BGR2RGB)
        res = fm.process(rgb)
        if not res.multi_face_landmarks:
            continue
        # use the largest face, people in the background are ignored
        lm = max(res.multi_face_landmarks,
                 key=lambda f: face_box(f.landmark)[1] - face_box(f.landmark)[0]).landmark
        box = face_box(lm)
        sh, sw = im.shape[:2]

        def pt(i):
            return lm[i].x * sw, lm[i].y * sh

        # head angles in degrees from the 3D mesh points (z has the same scale as x)
        lc, rc = lm[234], lm[454]
        yaw = math.degrees(math.atan2((rc.z - lc.z) * sw, (rc.x - lc.x) * sw))   # + = turned to image right
        top, chin = lm[10], lm[152]
        pitch = math.degrees(math.atan2((chin.z - top.z) * sw, (chin.y - top.y) * sh))  # + = looking down
        (ax, ay), (bx, by) = pt(33), pt(263)
        roll = math.degrees(math.atan2(by - ay, bx - ax))                          # 0 = head upright

        # face size from the face height, so turning the head does not make it smaller
        size = math.dist(pt(10), pt(152)) / 1.3 / sw
        eyes = max(eye_open(pt, LEFT_EYE), eye_open(pt, RIGHT_EYE))
        conf = detection_score(fd, rgb, box)
        big = img if rot is None else cv2.rotate(img, rot)
        sharp, bright = face_stats(big, box)
        result = {
            "yaw": yaw, "pitch": pitch, "size": size, "sharp": sharp, "bright": bright,
            "eyes": eyes, "roll": roll, "conf": conf,
            "cx": (box[0] + box[1]) / 2, "cy": (box[2] + box[3]) / 2,
            "box": box, "img": big, "jpg": jpg_bytes,
        }
        return result, rot
    return None, rot_hint


def quality_issue(p):
    """Return a message if the photo is not good enough (sharpness is checked separately)."""
    x0, x1, y0, y1 = p["box"]
    if p["conf"] < MIN_FACE_CONF:
        return "Face is not clear or is covered"
    if p["size"] < MIN_FACE_SIZE:
        return "Move the phone a little closer"
    if x0 < EDGE or y0 < EDGE or x1 > 1 - EDGE or y1 > 1 - EDGE:
        return "Keep the whole face inside the frame"
    if not (CENTER_X[0] < p["cx"] < CENTER_X[1] and CENTER_Y[0] < p["cy"] < CENTER_Y[1]):
        return "Keep the face in the center of the frame"
    if p["eyes"] < MIN_EYE_OPEN:
        return "Keep your eyes open"
    if abs(p["roll"]) > MAX_ROLL:
        return "Keep your head straight, do not tilt sideways"
    if p["bright"] < MIN_BRIGHT:
        return "Too dark, move to a brighter place"
    if p["bright"] > MAX_BRIGHT:
        return "Too bright, avoid strong light"
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


def crop_face(img, box, margin):
    """Square crop around the face with a margin. Returns JPEG bytes or None."""
    x0, x1, y0, y1 = box
    h, w = img.shape[:2]
    face = max((x1 - x0) * w, (y1 - y0) * h)
    side = max(1, min(int(face * (1 + 2 * margin)), h, w))
    cx, cy = (x0 + x1) / 2 * w, (y0 + y1) / 2 * h
    left = int(min(max(cx - side / 2, 0), w - side))
    top = int(min(max(cy - side / 2, 0), h - side))
    crop = img[top:top + side, left:left + side]
    if side > CROP_MAX_SIZE:
        crop = cv2.resize(crop, (CROP_MAX_SIZE, CROP_MAX_SIZE), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return buf.tobytes() if ok else None


def count_faces(detector, img):
    res = detector.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not res.detections:
        return 0
    return sum(1 for d in res.detections if d.score[0] >= PHOTO_MIN_CONF)


def photo_ok(detectors, jpg):
    """The enrollment API wants exactly one detectable face per photo."""
    img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return False
    return any(count_faces(d, img) == 1 for d in detectors)


def build_photo(detectors, item):
    """The photo to save and send, or None if no crop of it has exactly one detectable face."""
    if not CROP_FACES:
        return item["jpg"]
    for extra in (0.0, 0.15, 0.30):
        photo = crop_face(item["img"], item["box"], CROP_MARGIN + extra)
        if photo and photo_ok(detectors, photo):
            return photo
    return None


def fallback_photo(item):
    """Used when the checks above keep failing. The server decides, and may ask for a retake."""
    photo = crop_face(item["img"], item["box"], CROP_MARGIN + 0.15) if CROP_FACES else None
    return photo or item["jpg"]


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
    fd = mp.solutions.face_detection.FaceDetection(model_selection=1, min_detection_confidence=0.3)
    fd_near = mp.solutions.face_detection.FaceDetection(model_selection=0, min_detection_confidence=0.3)
    detectors = [fd_near, fd]
    step, shots, rot, base, cand = 0, [], None, None, None
    best_sharp, last_facing, retries, verify_fail = 0.0, None, 0, 0
    started = time.monotonic()
    try:
        await ws.send_json(status(STEPS[0][1], 0))
        while True:
            msg = await ws.receive_json()

            if msg["type"] == "frame" and step < len(STEPS):
                instruction = STEPS[step][1]
                if time.monotonic() - started < START_DELAY:
                    await ws.send_json(status(f"Get ready...\n{instruction}", len(shots)))
                    continue

                facing = msg.get("facing", "front")
                if facing != last_facing:
                    # a different camera has a different sharpness level, start fresh
                    last_facing, best_sharp, cand = facing, 0.0, None
                swap = SWAP_FRONT if facing == "front" else SWAP_BACK

                jpg = base64.b64decode(msg["data"])
                pose, rot = await asyncio.to_thread(analyze, fm, fd, jpg, rot)
                if pose is None:
                    cand = None
                    await ws.send_json(status(f"Face not detected\n{instruction}", len(shots)))
                    continue

                yaw = -pose["yaw"] if swap else pose["yaw"]
                pitch = pose["pitch"]
                need = max(MIN_SHARPNESS, SHARP_RATIO * best_sharp)
                d_yaw = yaw - base[0] if base else 0.0
                d_pitch = pitch - base[1] if base else 0.0
                dbg = (f"yaw={yaw:.0f} pitch={pitch:.0f} dYaw={d_yaw:+.0f} dPitch={d_pitch:+.0f} "
                       f"roll={pose['roll']:.0f}\n"
                       f"size={pose['size']:.2f} sharp={pose['sharp']:.0f}/{need:.0f} "
                       f"eyes={pose['eyes']:.2f} conf={pose['conf']:.2f} bright={pose['bright']:.0f}")

                issue = quality_issue(pose)
                if issue is None:
                    if pose["sharp"] < need:
                        issue = "Hold steady, the image is blurry"
                    # remember the sharpest level of this angle (slowly fades)
                    best_sharp = max(pose["sharp"], best_sharp * 0.97)
                if issue:
                    await ws.send_json(status(f"{issue}\n{instruction}", len(shots), dbg))
                    continue

                name = STEPS[step][0]
                if not angle_ok(name, yaw, pitch, base):
                    cand = None
                    await ws.send_json(status(instruction, len(shots), dbg, False))
                    continue

                cur = {"yaw": yaw, "pitch": pitch, "sharp": pose["sharp"],
                       "img": pose["img"], "box": pose["box"], "jpg": jpg}
                confirmed = None
                if not REQUIRE_STABLE:
                    confirmed = cur
                elif (cand is not None
                      and abs(yaw - cand["yaw"]) < STABLE_TOL
                      and abs(pitch - cand["pitch"]) < STABLE_TOL):
                    # two steady frames in a row: keep the sharper one
                    confirmed = cur if cur["sharp"] >= cand["sharp"] else cand

                if confirmed:
                    photo = await asyncio.to_thread(build_photo, detectors, confirmed)
                    if photo is None:
                        verify_fail += 1
                        if verify_fail < VERIFY_TRIES:
                            cand = None
                            await ws.send_json(status(
                                f"Photo is not clear enough, adjust slightly\n{instruction}",
                                len(shots), dbg))
                            continue
                        photo = fallback_photo(confirmed)   # let the server decide
                    verify_fail = 0
                    if name == "front":
                        base = (confirmed["yaw"], confirmed["pitch"])   # reference for the other angles
                    shots.append((name, photo))
                    step += 1
                    cand = None
                    best_sharp = 0.0
                    text = STEPS[step][1] if step < len(STEPS) else "Enrollment complete"
                    await ws.send_json(status(text, len(shots), dbg, True))
                else:
                    cand = cur
                    await ws.send_json(status(f"Hold still\n{instruction}", len(shots), dbg, True))

            elif msg["type"] == "submit":
                form = {k: v for k, v in msg.items() if k != "type"}
                try:
                    good, detail = await asyncio.to_thread(send_to_api, form, shots)
                except Exception as e:
                    print("API call failed:", e)
                    good, detail = False, str(e)

                # the API rejected one photo: retake only that angle (and the ones after it)
                bad = None
                if not good and "HTTP 422" in detail:
                    found = re.search(r"\b(front|left|right|up|bottom)\.jpg", detail)
                    if found:
                        bad = found.group(1)
                if bad and retries < MAX_RETRIES:
                    retries += 1
                    idx = STEP_NAMES.index(bad)
                    shots = shots[:idx]
                    step = idx
                    cand, best_sharp, verify_fail = None, 0.0, 0
                    if idx == 0:
                        base = None
                    await ws.send_json(status(
                        f"The {bad} photo was rejected by the server. Please repeat this angle.\n{STEPS[step][1]}",
                        len(shots)))
                else:
                    await ws.send_json({"type": "result", "ok": good, "detail": detail})
    except WebSocketDisconnect:
        pass
    finally:
        fm.close()
        fd.close()
        fd_near.close()