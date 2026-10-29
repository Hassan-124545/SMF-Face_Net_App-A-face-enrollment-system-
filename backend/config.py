"""Central configuration. Every value comes from the .env file in the project root."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Difficulty presets selected with ENROLL_MODE. Any single value can still be overridden in .env.
# Angles are in degrees, measured from the front photo (yaw: left/right, pitch: up/down).
PRESETS = {
    # quickest and easiest: captures on the first good frame
    "fast": {
        "REQUIRE_STABLE": False, "STABLE_TOL": 10, "START_DELAY": 0.0,
        "MIN_SHARPNESS": 4, "SHARP_RATIO": 0.30, "MIN_FACE_SIZE": 0.10,
        "FRONT_YAW_MIN": -22, "FRONT_YAW_MAX": 22,
        "FRONT_PITCH_MIN": -30, "FRONT_PITCH_MAX": 30,
        "YAW_DELTA": 10, "YAW_MAX": 45,
        "PITCH_DELTA": 7, "PITCH_MAX": 25, "CROSS_TOL": 22,
        "MIN_EYE_OPEN": 0.08, "MAX_ROLL": 35, "MIN_FACE_CONF": 0.30,
        "MIN_BRIGHT": 25, "MAX_BRIGHT": 245,
    },
    # recommended: every angle is confirmed by a second frame and photo quality is checked
    "balanced": {
        "REQUIRE_STABLE": True, "STABLE_TOL": 6, "START_DELAY": 0.8,
        "MIN_SHARPNESS": 10, "SHARP_RATIO": 0.50, "MIN_FACE_SIZE": 0.12,
        "FRONT_YAW_MIN": -15, "FRONT_YAW_MAX": 15,
        "FRONT_PITCH_MIN": -25, "FRONT_PITCH_MAX": 25,
        "YAW_DELTA": 15, "YAW_MAX": 40,
        "PITCH_DELTA": 10, "PITCH_MAX": 25, "CROSS_TOL": 15,
        "MIN_EYE_OPEN": 0.12, "MAX_ROLL": 20, "MIN_FACE_CONF": 0.50,
        "MIN_BRIGHT": 40, "MAX_BRIGHT": 230,
    },
    # best photo quality, slowest
    "strict": {
        "REQUIRE_STABLE": True, "STABLE_TOL": 3, "START_DELAY": 1.5,
        "MIN_SHARPNESS": 15, "SHARP_RATIO": 0.70, "MIN_FACE_SIZE": 0.20,
        "FRONT_YAW_MIN": -8, "FRONT_YAW_MAX": 8,
        "FRONT_PITCH_MIN": -15, "FRONT_PITCH_MAX": 15,
        "YAW_DELTA": 22, "YAW_MAX": 35,
        "PITCH_DELTA": 14, "PITCH_MAX": 22, "CROSS_TOL": 10,
        "MIN_EYE_OPEN": 0.16, "MAX_ROLL": 10, "MIN_FACE_CONF": 0.75,
        "MIN_BRIGHT": 55, "MAX_BRIGHT": 215,
    },
}


def _str(name, default=""):
    return os.getenv(name, default).strip()


def _float(name, default):
    try:
        return float(os.getenv(name, default))
    except ValueError:
        return float(default)


def _bool(name, default=False):
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


MODE = _str("ENROLL_MODE", "balanced").lower()
if MODE not in PRESETS:
    raise RuntimeError(f"ENROLL_MODE must be one of: {', '.join(PRESETS)} (got '{MODE}')")
_P = PRESETS[MODE]


def _num(name):
    """Number from .env, or the value of the selected preset."""
    raw = os.getenv(name, "").strip()
    try:
        return float(raw) if raw else float(_P[name])
    except ValueError:
        return float(_P[name])


def _flag(name):
    """True/False from .env, or the value of the selected preset."""
    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return bool(_P[name])
    return raw in ("1", "true", "yes", "on")


# ----- Required settings -----
ENROLL_URL = _str("ENROLL_URL")
API_KEY = _str("API_KEY")
APP_TOKEN = _str("APP_TOKEN")

_missing = [k for k, v in (("ENROLL_URL", ENROLL_URL), ("API_KEY", API_KEY), ("APP_TOKEN", APP_TOKEN)) if not v]
if _missing:
    raise RuntimeError(f"Missing settings in {ROOT / '.env'}: {', '.join(_missing)}")

# ----- Storage -----
CAPTURE_DIR = Path(__file__).resolve().parent / "captures"

# ----- Saved photos -----
CROP_FACES = _bool("CROP_FACES", True)            # save and send only the face area
CROP_MARGIN = _float("CROP_MARGIN", 0.45)         # extra space around the face (fraction of face size)
CROP_MAX_SIZE = int(_float("CROP_MAX_SIZE", 640))  # cropped photo is shrunk to this size if larger
PHOTO_MIN_CONF = _float("PHOTO_MIN_CONF", 0.40)   # a cropped photo must contain exactly one face above this score
VERIFY_TRIES = int(_float("VERIFY_TRIES", 3))     # after this many failed checks the photo is sent anyway

# ----- Camera direction -----
SWAP_FRONT = _bool("SWAP_FRONT", False)
SWAP_BACK = _bool("SWAP_BACK", False)

# ----- Quality checks -----
MIN_FACE_SIZE = _num("MIN_FACE_SIZE")
MIN_SHARPNESS = _num("MIN_SHARPNESS")    # absolute minimum sharpness (safety floor)
SHARP_RATIO = _num("SHARP_RATIO")        # a frame must reach this share of the sharpest frame of the same angle
MIN_EYE_OPEN = _num("MIN_EYE_OPEN")
MAX_ROLL = _num("MAX_ROLL")
MIN_FACE_CONF = _num("MIN_FACE_CONF")
MIN_BRIGHT = _num("MIN_BRIGHT")
MAX_BRIGHT = _num("MAX_BRIGHT")
CENTER_X = (0.25, 0.75)
CENTER_Y = (0.20, 0.80)

# ----- Angle checks (degrees) -----
FRONT_YAW = (_num("FRONT_YAW_MIN"), _num("FRONT_YAW_MAX"))
FRONT_PITCH = (_num("FRONT_PITCH_MIN"), _num("FRONT_PITCH_MAX"))
YAW_DELTA = _num("YAW_DELTA")
YAW_MAX = _num("YAW_MAX")
PITCH_DELTA = _num("PITCH_DELTA")
PITCH_MAX = _num("PITCH_MAX")
CROSS_TOL = _num("CROSS_TOL")

# ----- Capture stability -----
REQUIRE_STABLE = _flag("REQUIRE_STABLE")
STABLE_TOL = _num("STABLE_TOL")
START_DELAY = _num("START_DELAY")

# ----- Server rejections -----
MAX_RETRIES = int(_float("MAX_RETRIES", 3))       # how many times a rejected angle is retaken

print(f"Enrollment mode: {MODE}")