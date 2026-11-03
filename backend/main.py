
import asyncio
import base64
import csv
import hmac
import math
import re
import threading
import time

import cv2
import mediapipe as mp
import numpy as np
import requests

from fastapi import (
    FastAPI,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    import oracledb
except ImportError:
    oracledb = None

import auth

from config import (
    API_KEY,
    APP_TOKEN,
    AUDIT_FILE,
    AUTH_MODE,
    CAPTURE_DIR,
    CENTER_X,
    CENTER_Y,
    CORS_ORIGINS,
    CROP_FACES,
    CROP_MARGIN,
    CROP_MAX_SIZE,
    CROSS_TOL,
    EMP_DB_DSN,
    EMP_DB_PASSWORD,
    EMP_DB_USER,
    EMP_LOOKUP_SQL,
    ENROLL_URL,
    FRONT_PITCH,
    FRONT_YAW,
    MAX_BRIGHT,
    MAX_RETRIES,
    MAX_ROLL,
    MIN_BRIGHT,
    MIN_EYE_OPEN,
    MIN_FACE_CONF,
    MIN_FACE_SIZE,
    MIN_SHARPNESS,
    PHOTO_MIN_CONF,
    PITCH_DELTA,
    PITCH_MAX,
    REQUIRE_STABLE,
    SAVE_LOCAL_COPIES,
    SHARP_RATIO,
    STABLE_TOL,
    START_DELAY,
    SWAP_BACK,
    SWAP_FRONT,
    SWAP_WEB_FRONT,
    TOKEN_HOURS,
    VERIFY_TRIES,
    YAW_DELTA,
    YAW_MAX,
    SIGNUP_REQUIRES_APPROVAL,
)


STEPS = [
    ("front", "Look straight at the camera"),
    ("left", "Turn your face to your LEFT"),
    ("right", "Turn your face to your RIGHT"),
    ("up", "Tilt UP, keep eyes on the camera"),
    ("bottom", "Tilt DOWN, keep eyes on the camera"),
]

STEP_NAMES = [s[0] for s in STEPS]

ROTATIONS = [
    None,
    cv2.ROTATE_90_CLOCKWISE,
    cv2.ROTATE_90_COUNTERCLOCKWISE,
    cv2.ROTATE_180,
]

LEFT_EYE = (33, 160, 158, 133, 153, 144)
RIGHT_EYE = (362, 385, 387, 263, 373, 380)

EDGE = 0.01

LOOKUP_KEYS = [
    "employee_id",
    "employee_name",
    "deptt_name",
    "section_name",
    "designation_name",
]


app = FastAPI(
    title="SM FaceID API",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_audit_lock = threading.Lock()


# ============================================================
# AUTHENTICATION
# ============================================================

def authenticate(token):
    """Return the operator name when the token is valid."""

    if not token:
        return None

    if AUTH_MODE == "login":
        return auth.verify_token(token)

    return (
        "shared-token"
        if hmac.compare_digest(token.encode(), APP_TOKEN.encode())
        else None
    )


class LoginBody(BaseModel):
    username: str
    password: str


class SignupBody(BaseModel):
    username: str
    name: str
    password: str


@app.get("/health")
def health():
    return {
        "status": "ok",
        "auth": AUTH_MODE,
        "signup_enabled": AUTH_MODE == "login",
        "signup_requires_approval": SIGNUP_REQUIRES_APPROVAL,
    }


@app.post("/api/signup")
def signup(body: SignupBody, request: Request):
    """
    Create a new operator account.

    SIGNUP_REQUIRES_APPROVAL=false:
        Account is activated immediately and a JWT is returned.

    SIGNUP_REQUIRES_APPROVAL=true:
        Account remains pending until an administrator approves it.
    """

    if AUTH_MODE != "login":
        raise HTTPException(
            status_code=404,
            detail="Signup is not enabled",
        )

    username = body.username.strip().lower()
    name = body.name.strip()
    password = body.password

    # Username validation
    if len(username) < 3 or len(username) > 40:
        raise HTTPException(
            status_code=400,
            detail="Username must contain 3 to 40 characters",
        )

    if not re.fullmatch(r"[a-z0-9_.-]+", username):
        raise HTTPException(
            status_code=400,
            detail="Username can contain only letters, numbers, dots, underscores and hyphens",
        )

    # Name validation
    if len(name) < 2 or len(name) > 100:
        raise HTTPException(
            status_code=400,
            detail="Full name must contain 2 to 100 characters",
        )

    # Password validation
    if len(password) < 8:
        raise HTTPException(
            status_code=400,
            detail="Password must have at least 8 characters",
        )

    if len(password) > 128:
        raise HTTPException(
            status_code=400,
            detail="Password cannot exceed 128 characters",
        )

    account_status = (
        "pending"
        if SIGNUP_REQUIRES_APPROVAL
        else "active"
    )

    try:
        auth.create_user(
            username=username,
            name=name,
            password=password,
            status=account_status,
        )

    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail=str(exc),
        )

    except Exception as exc:
        print("Signup failed:", exc)

        raise HTTPException(
            status_code=500,
            detail="Unable to create account",
        )

    # Admin approval mode
    if account_status == "pending":
        return {
            "status": "pending",
            "message": "Account created. Waiting for admin approval.",
        }

    # Automatic activation mode
    user = {
        "username": username,
        "name": name,
    }

    token = auth.make_token(user)

    return {
        "status": "active",
        "token": token,
        "name": name,
        "expires_in": int(TOKEN_HOURS * 3600),
    }


@app.post("/api/login")
def login(body: LoginBody, request: Request):
    if AUTH_MODE != "login":
        raise HTTPException(
            status_code=404,
            detail="Login is not enabled",
        )

    key = (
        f"{request.client.host if request.client else '-'}:"
        f"{body.username.strip().lower()}"
    )

    if auth.is_locked(key):
        raise HTTPException(
            status_code=429,
            detail="Too many failed attempts",
        )

    user = auth.check_password(
        body.username,
        body.password,
    )

    if not user:
        auth.record_fail(key)

        raise HTTPException(
            status_code=401,
            detail="Wrong username or password",
        )

    auth.clear_fails(key)

    return {
        "token": auth.make_token(user),
        "name": user["name"],
        "expires_in": int(TOKEN_HOURS * 3600),
    }


# ============================================================
# AUDIT LOGGING
# ============================================================

def write_audit(operator, form, ok, detail):
    """Record who enrolled whom and the result."""

    row = [
        time.strftime("%Y-%m-%d %H:%M:%S"),
        operator,
        form.get("employee_id", ""),
        form.get("employee_card_no", ""),
        "ok" if ok else "failed",
        str(detail)[:120].replace("\n", " "),
    ]

    with _audit_lock:
        new_file = not AUDIT_FILE.exists()

        with open(
            AUDIT_FILE,
            "a",
            newline="",
            encoding="utf-8",
        ) as fh:
            writer = csv.writer(fh)

            if new_file:
                writer.writerow([
                    "time",
                    "operator",
                    "employee_id",
                    "card_no",
                    "result",
                    "detail",
                ])

            writer.writerow(row)


# ============================================================
# EMPLOYEE LOOKUP
# ============================================================

@app.get("/employee/{card_no}")
def get_employee(
    card_no: str,
    token: str = "",
    authorization: str = Header(default=""),
):
    """Find an employee using the configured Oracle SQL."""

    bearer = (
        authorization[7:]
        if authorization.lower().startswith("bearer ")
        else ""
    )

    if not authenticate(bearer or token):
        raise HTTPException(
            status_code=401,
            detail="Not signed in",
        )

    if (
        oracledb is None
        or not (EMP_DB_USER and EMP_DB_DSN and EMP_LOOKUP_SQL)
    ):
        raise HTTPException(
            status_code=503,
            detail="Employee lookup is not configured",
        )

    try:
        with oracledb.connect(
            user=EMP_DB_USER,
            password=EMP_DB_PASSWORD,
            dsn=EMP_DB_DSN,
        ) as conn:

            with conn.cursor() as cur:
                cur.execute(
                    EMP_LOOKUP_SQL,
                    card=card_no.strip(),
                )

                row = cur.fetchone()

    except Exception as e:
        print("Employee lookup failed:", e)

        raise HTTPException(
            status_code=500,
            detail="Database error",
        )

    if not row:
        raise HTTPException(
            status_code=404,
            detail="Employee not found",
        )

    return {
        key: ("" if value is None else str(value))
        for key, value in zip(LOOKUP_KEYS, row)
    }


# ============================================================
# FACE ANALYSIS
# ============================================================

def face_box(lm):
    xs = [p.x for p in lm]
    ys = [p.y for p in lm]

    return (
        min(xs),
        max(xs),
        min(ys),
        max(ys),
    )


def face_stats(img, box):
    """Return sharpness and brightness of the face area."""

    x0, x1, y0, y1 = box

    h, w = img.shape[:2]

    a = max(int(x0 * w), 0)
    b = min(int(x1 * w), w)

    c = max(int(y0 * h), 0)
    d = min(int(y1 * h), h)

    if b - a < 20 or d - c < 20:
        return 0.0, 0.0

    gray = cv2.cvtColor(
        img[c:d, a:b],
        cv2.COLOR_BGR2GRAY,
    )

    gray = cv2.resize(
        gray,
        (200, 200),
        interpolation=cv2.INTER_AREA,
    )

    sharp = float(
        cv2.Laplacian(
            cv2.GaussianBlur(gray, (3, 3), 0),
            cv2.CV_64F,
        ).var()
    )

    return sharp, float(gray.mean())


def eye_open(pt, ids):
    p1, p2, p3, p4, p5, p6 = (
        pt(i) for i in ids
    )

    return (
        math.dist(p2, p6) + math.dist(p3, p5)
    ) / (
        2 * math.dist(p1, p4) + 1e-6
    )


def detection_score(fd, rgb, box):
    """Confidence of the separate face detector."""

    res = fd.process(rgb)

    if not res.detections:
        return 0.0

    x0, x1, y0, y1 = box

    best = 0.0

    for d in res.detections:
        b = d.location_data.relative_bounding_box

        cx = b.xmin + b.width / 2
        cy = b.ymin + b.height / 2

        if x0 <= cx <= x1 and y0 <= cy <= y1:
            best = max(best, d.score[0])

    return float(best)


def analyze(fm, fd, jpg_bytes, rot_hint):
    """Analyze a frame and try rotated copies if needed."""

    img = cv2.imdecode(
        np.frombuffer(jpg_bytes, np.uint8),
        cv2.IMREAD_COLOR,
    )

    if img is None:
        return None, rot_hint

    h, w = img.shape[:2]

    scale = 640 / max(h, w)

    small = (
        cv2.resize(
            img,
            (int(w * scale), int(h * scale)),
        )
        if scale < 1
        else img
    )

    order = [rot_hint] + [
        r for r in ROTATIONS if r != rot_hint
    ]

    for rot in order:
        im = (
            small
            if rot is None
            else cv2.rotate(small, rot)
        )

        rgb = cv2.cvtColor(
            im,
            cv2.COLOR_BGR2RGB,
        )

        res = fm.process(rgb)

        if not res.multi_face_landmarks:
            continue

        lm = max(
            res.multi_face_landmarks,
            key=lambda f: (
                face_box(f.landmark)[1]
                - face_box(f.landmark)[0]
            ),
        ).landmark

        box = face_box(lm)

        sh, sw = im.shape[:2]

        def pt(i):
            return lm[i].x * sw, lm[i].y * sh

        lc, rc = lm[234], lm[454]

        yaw = math.degrees(
            math.atan2(
                (rc.z - lc.z) * sw,
                (rc.x - lc.x) * sw,
            )
        )

        top, chin = lm[10], lm[152]

        pitch = math.degrees(
            math.atan2(
                (chin.z - top.z) * sw,
                (chin.y - top.y) * sh,
            )
        )

        (ax, ay), (bx, by) = pt(33), pt(263)

        roll = math.degrees(
            math.atan2(by - ay, bx - ax)
        )

        size = math.dist(
            pt(10),
            pt(152),
        ) / 1.3 / sw

        eyes = max(
            eye_open(pt, LEFT_EYE),
            eye_open(pt, RIGHT_EYE),
        )

        conf = detection_score(
            fd,
            rgb,
            box,
        )

        big = (
            img
            if rot is None
            else cv2.rotate(img, rot)
        )

        sharp, bright = face_stats(big, box)

        result = {
            "yaw": yaw,
            "pitch": pitch,
            "size": size,
            "sharp": sharp,
            "bright": bright,
            "eyes": eyes,
            "roll": roll,
            "conf": conf,
            "cx": (box[0] + box[1]) / 2,
            "cy": (box[2] + box[3]) / 2,
            "box": box,
            "img": big,
            "jpg": jpg_bytes,
        }

        return result, rot

    return None, rot_hint


def quality_issue(p):
    """Return a message if the photo is not good enough."""

    x0, x1, y0, y1 = p["box"]

    if p["conf"] < MIN_FACE_CONF:
        return "Face is not clear or is covered"

    if p["size"] < MIN_FACE_SIZE:
        return "Move the phone a little closer"

    if (
        x0 < EDGE
        or y0 < EDGE
        or x1 > 1 - EDGE
        or y1 > 1 - EDGE
    ):
        return "Keep the whole face inside the frame"

    if not (
        CENTER_X[0] < p["cx"] < CENTER_X[1]
        and CENTER_Y[0] < p["cy"] < CENTER_Y[1]
    ):
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
        return (
            FRONT_YAW[0] < yaw < FRONT_YAW[1]
            and FRONT_PITCH[0] < pitch < FRONT_PITCH[1]
        )

    if base is None:
        return False

    base_yaw, base_pitch = base

    if name == "left":
        return (
            YAW_DELTA < yaw - base_yaw < YAW_MAX
            and abs(pitch - base_pitch) < CROSS_TOL
        )

    if name == "right":
        return (
            YAW_DELTA < base_yaw - yaw < YAW_MAX
            and abs(pitch - base_pitch) < CROSS_TOL
        )

    if name == "up":
        return (
            PITCH_DELTA < base_pitch - pitch < PITCH_MAX
            and abs(yaw - base_yaw) < CROSS_TOL
        )

    if name == "bottom":
        return (
            PITCH_DELTA < pitch - base_pitch < PITCH_MAX
            and abs(yaw - base_yaw) < CROSS_TOL
        )

    return False


# ============================================================
# PHOTO PROCESSING
# ============================================================

def crop_face(img, box, margin):
    """Square crop around the face."""

    x0, x1, y0, y1 = box

    h, w = img.shape[:2]

    face = max(
        (x1 - x0) * w,
        (y1 - y0) * h,
    )

    side = max(
        1,
        min(
            int(face * (1 + 2 * margin)),
            h,
            w,
        ),
    )

    cx = (x0 + x1) / 2 * w
    cy = (y0 + y1) / 2 * h

    left = int(
        min(max(cx - side / 2, 0), w - side)
    )

    top = int(
        min(max(cy - side / 2, 0), h - side)
    )

    crop = img[
        top:top + side,
        left:left + side,
    ]

    if side > CROP_MAX_SIZE:
        crop = cv2.resize(
            crop,
            (CROP_MAX_SIZE, CROP_MAX_SIZE),
            interpolation=cv2.INTER_AREA,
        )

    ok, buf = cv2.imencode(
        ".jpg",
        crop,
        [cv2.IMWRITE_JPEG_QUALITY, 92],
    )

    return buf.tobytes() if ok else None


def count_faces(detector, img):
    res = detector.process(
        cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    )

    if not res.detections:
        return 0

    return sum(
        1
        for d in res.detections
        if d.score[0] >= PHOTO_MIN_CONF
    )


def photo_ok(detectors, jpg):
    """The enrollment API wants exactly one detectable face."""

    img = cv2.imdecode(
        np.frombuffer(jpg, np.uint8),
        cv2.IMREAD_COLOR,
    )

    if img is None:
        return False

    return any(
        count_faces(d, img) == 1
        for d in detectors
    )


def build_photo(detectors, item):
    """Return a valid face crop, or None."""

    if not CROP_FACES:
        return item["jpg"]

    for extra in (0.0, 0.15, 0.30):
        photo = crop_face(
            item["img"],
            item["box"],
            CROP_MARGIN + extra,
        )

        if photo and photo_ok(detectors, photo):
            return photo

    return None


def fallback_photo(item):
    """Fallback photo if crop verification keeps failing."""

    photo = (
        crop_face(
            item["img"],
            item["box"],
            CROP_MARGIN + 0.15,
        )
        if CROP_FACES
        else None
    )

    return photo or item["jpg"]


def status(msg, got, dbg="", match=False):
    return {
        "type": "status",
        "msg": msg,
        "got": got,
        "total": len(STEPS),
        "done": got == len(STEPS),
        "dbg": dbg,
        "match": match,
    }


def save_copies(employee_id, shots):
    folder = CAPTURE_DIR / (
        employee_id or "unknown"
    )

    folder.mkdir(
        parents=True,
        exist_ok=True,
    )

    for name, jpg in shots:
        (
            folder / f"{name}.jpg"
        ).write_bytes(jpg)


def send_to_api(form, shots):
    if SAVE_LOCAL_COPIES:
        save_copies(
            form.get("employee_id", ""),
            shots,
        )

    data = [
        (k, v)
        for k, v in form.items()
        if v
    ]

    data += [
        ("angles", name)
        for name, _ in shots
    ]

    files = [
        (
            "images",
            (f"{name}.jpg", jpg, "image/jpeg"),
        )
        for name, jpg in shots
    ]

    print("POST to:", ENROLL_URL)
    print("Sending to API:", data)

    r = requests.post(
        ENROLL_URL,
        headers={"X-API-Key": API_KEY},
        data=data,
        files=files,
        timeout=60,
        allow_redirects=False,
    )

    print("API response:", r.status_code, r.text)

    if r.is_redirect:
        target = r.headers.get("location")

        print("Redirected to:", target)

        return (
            False,
            f"HTTP {r.status_code}: the server redirected to "
            f"{target}. Use that URL as ENROLL_URL.",
        )

    return (
        r.ok,
        f"HTTP {r.status_code}: {r.text[:500]}",
    )


# ============================================================
# WEBSOCKET ENROLLMENT
# ============================================================

@app.websocket("/ws/enroll")
async def enroll_ws(ws: WebSocket, token: str = ""):
    await ws.accept()

    operator = await asyncio.to_thread(
        authenticate,
        token,
    )

    if not operator:
        await ws.close(code=4001)
        return

    fm = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=3,
        min_detection_confidence=0.3,
    )

    fd = mp.solutions.face_detection.FaceDetection(
        model_selection=1,
        min_detection_confidence=0.3,
    )

    fd_near = mp.solutions.face_detection.FaceDetection(
        model_selection=0,
        min_detection_confidence=0.3,
    )

    detectors = [fd_near, fd]

    step = 0
    shots = []
    rot = None
    base = None
    cand = None

    best_sharp = 0.0
    last_facing = None
    retries = 0
    verify_fail = 0

    started = time.monotonic()

    try:
        await ws.send_json(
            status(STEPS[0][1], 0)
        )

        while True:
            msg = await ws.receive_json()

            if (
                msg["type"] == "frame"
                and step < len(STEPS)
            ):
                instruction = STEPS[step][1]

                if time.monotonic() - started < START_DELAY:
                    await ws.send_json(
                        status(
                            f"Get ready...\n{instruction}",
                            len(shots),
                        )
                    )
                    continue

                facing = msg.get("facing", "front")
                client = msg.get("client", "app")

                if facing != last_facing:
                    last_facing = facing
                    best_sharp = 0.0
                    cand = None

                if facing == "front":
                    swap = (
                        SWAP_WEB_FRONT
                        if client == "web"
                        else SWAP_FRONT
                    )
                else:
                    swap = SWAP_BACK

                jpg = base64.b64decode(msg["data"])

                pose, rot = await asyncio.to_thread(
                    analyze,
                    fm,
                    fd,
                    jpg,
                    rot,
                )

                if pose is None:
                    cand = None

                    await ws.send_json(
                        status(
                            f"Face not detected\n{instruction}",
                            len(shots),
                        )
                    )
                    continue

                yaw = (
                    -pose["yaw"]
                    if swap
                    else pose["yaw"]
                )

                pitch = pose["pitch"]

                need = max(
                    MIN_SHARPNESS,
                    SHARP_RATIO * best_sharp,
                )

                d_yaw = (
                    yaw - base[0]
                    if base
                    else 0.0
                )

                d_pitch = (
                    pitch - base[1]
                    if base
                    else 0.0
                )

                dbg = (
                    f"yaw={yaw:.0f} pitch={pitch:.0f} "
                    f"dYaw={d_yaw:+.0f} dPitch={d_pitch:+.0f} "
                    f"roll={pose['roll']:.0f}\n"
                    f"size={pose['size']:.2f} "
                    f"sharp={pose['sharp']:.0f}/{need:.0f} "
                    f"eyes={pose['eyes']:.2f} "
                    f"conf={pose['conf']:.2f} "
                    f"bright={pose['bright']:.0f}"
                )

                issue = quality_issue(pose)

                if issue is None:
                    if pose["sharp"] < need:
                        issue = "Hold steady, the image is blurry"

                    best_sharp = max(
                        pose["sharp"],
                        best_sharp * 0.97,
                    )

                if issue:
                    await ws.send_json(
                        status(
                            f"{issue}\n{instruction}",
                            len(shots),
                            dbg,
                        )
                    )
                    continue

                name = STEPS[step][0]

                if not angle_ok(
                    name,
                    yaw,
                    pitch,
                    base,
                ):
                    cand = None

                    await ws.send_json(
                        status(
                            instruction,
                            len(shots),
                            dbg,
                            False,
                        )
                    )
                    continue

                cur = {
                    "yaw": yaw,
                    "pitch": pitch,
                    "sharp": pose["sharp"],
                    "img": pose["img"],
                    "box": pose["box"],
                    "jpg": jpg,
                }

                confirmed = None

                if not REQUIRE_STABLE:
                    confirmed = cur

                elif (
                    cand is not None
                    and abs(yaw - cand["yaw"]) < STABLE_TOL
                    and abs(pitch - cand["pitch"]) < STABLE_TOL
                ):
                    confirmed = (
                        cur
                        if cur["sharp"] >= cand["sharp"]
                        else cand
                    )

                if confirmed:
                    photo = await asyncio.to_thread(
                        build_photo,
                        detectors,
                        confirmed,
                    )

                    if photo is None:
                        verify_fail += 1

                        if verify_fail < VERIFY_TRIES:
                            cand = None

                            await ws.send_json(
                                status(
                                    "Photo is not clear enough, "
                                    f"adjust slightly\n{instruction}",
                                    len(shots),
                                    dbg,
                                )
                            )
                            continue

                        photo = fallback_photo(confirmed)

                    verify_fail = 0

                    if name == "front":
                        base = (
                            confirmed["yaw"],
                            confirmed["pitch"],
                        )

                    shots.append((name, photo))

                    step += 1
                    cand = None
                    best_sharp = 0.0

                    text = (
                        STEPS[step][1]
                        if step < len(STEPS)
                        else "Enrollment complete"
                    )

                    await ws.send_json(
                        status(
                            text,
                            len(shots),
                            dbg,
                            True,
                        )
                    )

                else:
                    cand = cur

                    await ws.send_json(
                        status(
                            f"Hold still\n{instruction}",
                            len(shots),
                            dbg,
                            True,
                        )
                    )

            elif msg["type"] == "submit":
                form = {
                    k: v
                    for k, v in msg.items()
                    if k != "type"
                }

                try:
                    good, detail = await asyncio.to_thread(
                        send_to_api,
                        form,
                        shots,
                    )

                except Exception as e:
                    print("API call failed:", e)

                    good = False
                    detail = str(e)

                await asyncio.to_thread(
                    write_audit,
                    operator,
                    form,
                    good,
                    detail,
                )

                # If the API rejects one photo, retake that angle
                # and all following angles.
                bad = None

                if not good and "HTTP 422" in detail:
                    found = re.search(
                        r"\b(front|left|right|up|bottom)\.jpg",
                        detail,
                    )

                    if found:
                        bad = found.group(1)

                if bad and retries < MAX_RETRIES:
                    retries += 1

                    idx = STEP_NAMES.index(bad)

                    shots = shots[:idx]
                    step = idx

                    cand = None
                    best_sharp = 0.0
                    verify_fail = 0

                    if idx == 0:
                        base = None

                    await ws.send_json(
                        status(
                            f"The {bad} photo was rejected by "
                            f"the server. Please repeat this angle.\n"
                            f"{STEPS[step][1]}",
                            len(shots),
                        )
                    )

                else:
                    await ws.send_json(
                        {
                            "type": "result",
                            "ok": good,
                            "detail": detail,
                        }
                    )

    except WebSocketDisconnect:
        pass

    finally:
        fm.close()
        fd.close()
        fd_near.close()
