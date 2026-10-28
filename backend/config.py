"""Central configuration. Every value comes from the .env file in the project root."""
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

# Difficulty presets selected with ENROLL_MODE. Any single value can still be overridden in .env.
PRESETS = {
    # quickest and easiest: captures on the first good frame
    "fast": {
        "REQUIRE_STABLE": False, "STABLE_TOL": 0.10, "START_DELAY": 0.5,
        "MIN_SHARPNESS": 20, "MIN_FACE_SIZE": 0.12,
        "FRONT_YAW_MIN": 0.35, "FRONT_YAW_MAX": 0.65,
        "FRONT_PITCH_MIN": 0.36, "FRONT_PITCH_MAX": 0.70,
        "YAW_DELTA": 0.05, "YAW_MAX": 0.55,
        "PITCH_DELTA": 0.04, "PITCH_MAX": 0.50, "CROSS_TOL": 0.30,
    },
    # every angle is confirmed by a second frame
    "balanced": {
        "REQUIRE_STABLE": True, "STABLE_TOL": 0.10, "START_DELAY": 1.0,
        "MIN_SHARPNESS": 30, "MIN_FACE_SIZE": 0.15,
        "FRONT_YAW_MIN": 0.38, "FRONT_YAW_MAX": 0.62,
        "FRONT_PITCH_MIN": 0.40, "FRONT_PITCH_MAX": 0.66,
        "YAW_DELTA": 0.06, "YAW_MAX": 0.50,
        "PITCH_DELTA": 0.05, "PITCH_MAX": 0.45, "CROSS_TOL": 0.25,
    },
    # best photo quality, slowest
    "strict": {
        "REQUIRE_STABLE": True, "STABLE_TOL": 0.04, "START_DELAY": 2.0,
        "MIN_SHARPNESS": 60, "MIN_FACE_SIZE": 0.25,
        "FRONT_YAW_MIN": 0.42, "FRONT_YAW_MAX": 0.58,
        "FRONT_PITCH_MIN": 0.45, "FRONT_PITCH_MAX": 0.62,
        "YAW_DELTA": 0.10, "YAW_MAX": 0.40,
        "PITCH_DELTA": 0.08, "PITCH_MAX": 0.35, "CROSS_TOL": 0.15,
    },
}


def _str(name, default=""):
    return os.getenv(name, default).strip()


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


def _bool(name, default=False):
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# ----- Required settings -----
ENROLL_URL = _str("ENROLL_URL")
API_KEY = _str("API_KEY")
APP_TOKEN = _str("APP_TOKEN")

_missing = [k for k, v in (("ENROLL_URL", ENROLL_URL), ("API_KEY", API_KEY), ("APP_TOKEN", APP_TOKEN)) if not v]
if _missing:
    raise RuntimeError(f"Missing settings in {ROOT / '.env'}: {', '.join(_missing)}")

# ----- Storage -----
CAPTURE_DIR = Path(__file__).resolve().parent / "captures"

# ----- Camera direction -----
SWAP_FRONT = _bool("SWAP_FRONT", False)
SWAP_BACK = _bool("SWAP_BACK", False)

# ----- Quality checks -----
MIN_FACE_SIZE = _num("MIN_FACE_SIZE")
MIN_SHARPNESS = _num("MIN_SHARPNESS")
CENTER_X = (0.25, 0.75)
CENTER_Y = (0.20, 0.80)

# ----- Angle checks -----
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

print(f"Enrollment mode: {MODE}")