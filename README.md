# SM FaceID (test-dev branch)

Employee face enrollment for attendance. An Android app and a web app (React Native / Expo) guide the person through a live multi-angle face capture, and a Python backend checks every photo in real time before sending the enrollment to the company enrollment API.

> **This is the test version (`test-dev` branch).** It is used to try new features before they reach `main`. It has its own identity so it can be installed next to the production app: app name `SM FaceID TEST`, package `com.smfoods.faceid.test` and backend port `8006` in the examples.

## What this branch adds

- Employee lookup by card number: type the card number and the employee details fill in automatically (the Employee ID stays hidden). Optional, it needs the Oracle details of the employee table. Without them the app falls back to manual entry.
- A web version of the app (runs in the browser).
- `https` / `wss` support for servers behind TLS.
- A switch to stop keeping local copies of the photos (`SAVE_LOCAL_COPIES`).
- Android test builds from GitHub Actions on tags named `test-v*`.

## Features

- Guided capture of five angles: front, left, right, up and down
- Live feedback over WebSocket: the frame turns green when the position is right and red when it is not
- Works with the front and the back camera
- Head angles are measured in degrees from the 3D face mesh, relative to the front photo
- Quality checks: blur, brightness, open eyes, straight head, uncovered face, face size and position
- Only the face area is cropped and sent. Every crop is checked to contain exactly one detectable face
- If the enrollment API rejects the photo of one angle, only that angle is retaken
- Three difficulty modes (`fast`, `balanced`, `strict`) selected with one line in `.env`
- Enrollment history on the device, light and dark theme
- One central `.env` file for all settings (no secrets in the code)

## How it works

```
+---------------+   WebSocket (frames)    +-----------------------+   HTTP + API key   +----------------+
| App / Web app | ----------------------> | Python backend        | -----------------> | Enrollment API |
| (Expo)        | <---------------------- | (FastAPI + MediaPipe) |                    | (Oracle)       |
+---------------+   guidance and status   +-----------+-----------+                    +----------------+
                                                       |
                                                       | card number lookup (optional)
                                                       v
                                               Oracle employee table
```

1. The app sends small camera frames to the backend.
2. The backend finds the face, measures the angle and the photo quality, and answers with the next instruction.
3. When all five angles are captured, the backend uploads the face crops with the employee details to the enrollment API. The API stores the images and the face vectors.

## Repository structure

```
.
├── .env.example                Template for the configuration file
├── .gitignore
├── README.md
├── .github/workflows/
│   └── android-test.yml        Builds the test APK when a test-v* tag is pushed
├── backend/
│   ├── main.py                 FastAPI app, quality checks, employee lookup, WebSocket flow
│   ├── config.py               Loads settings and difficulty presets from .env
│   └── requirements.txt
└── app/
    ├── App.js                  All screens (Android, iOS and web)
    ├── app.config.js           Expo configuration (reads .env)
    └── package.json
```

## Requirements

- Python 3.11
- Node.js 20 or newer
- Access to the enrollment API and its API key
- For the Android app in development: the Expo Go app on a phone in the same network as the backend PC
- For the web app: a desktop browser with a webcam (works on `localhost`). Phones need an HTTPS server, because browsers only allow the camera on secure pages.

## Setup

### 1. Configure

```powershell
copy .env.example .env
```

Fill in your own values. Restart the backend after changing the tuning values and restart the app (`npx expo start -c`) after changing anything else.

| Variable | Description |
|---|---|
| `ENROLL_URL` | Full URL of the enrollment API endpoint |
| `API_KEY` | API key of the enrollment API (stays on the backend only) |
| `APP_TOKEN` | Shared token the app sends to the backend. Use a long random value |
| `SERVER_HOST`, `SERVER_PORT` | Address of the backend. Use `localhost` to test the web app on the same PC |
| `SERVER_SECURE` | `true` when the backend is reached through `https` / `wss` |
| `CORS_ORIGINS` | Web pages allowed to call the backend, comma separated |
| `SWAP_WEB_FRONT` | `true` if left and right are reversed on the web front camera |
| `APP_NAME`, `APP_SLUG` | App name and Expo slug |
| `APP_VERSION` | App version, for example `1.0.0` |
| `ANDROID_PACKAGE`, `IOS_BUNDLE_ID` | Unique application identifiers |
| `GITHUB_REPO` | `username/repository`, used by the update notice. Leave empty to turn the notice off |
| `APP_DEBUG` | `true` shows live measurements on the camera screen |
| `EMP_DB_USER`, `EMP_DB_PASSWORD`, `EMP_DB_DSN` | Oracle connection for the employee lookup. Leave `EMP_DB_USER` empty to turn it off |
| `EMP_LOOKUP_SQL` | SQL used for the lookup (see below) |
| `ENROLL_MODE` | `fast`, `balanced` or `strict` |
| `SWAP_FRONT`, `SWAP_BACK` | `true` if left and right are reversed for that camera |
| `CROP_FACES`, `CROP_MARGIN`, `CROP_MAX_SIZE` | Face cropping of the saved and uploaded photos |
| `SAVE_LOCAL_COPIES` | `false` stops the backend from keeping local copies in `backend/captures` |
| `WEB_BASE_URL` | Sub folder when the web app is hosted in one, for example `/repo-name` |

### 2. Run the backend

```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8006
```

Open `http://localhost:8006/health` to check it. To reach it from a phone, allow the port in the Windows firewall:

```powershell
netsh advfirewall firewall add rule name="face8006" dir=in action=allow protocol=TCP localport=8006
```

### 3. Run the app

```powershell
cd app
npm install
npx expo install react-dom react-native-web @expo/metro-runtime expo-build-properties
npx expo start -c
```

Scan the QR code with Expo Go. The home screen shows **Server connected** when the backend is reachable.

### 4. Run the web app

Set `SERVER_HOST=localhost` and the backend port in `.env`, then:

```powershell
cd app
npx expo start --web -c
```

Open `http://localhost:8081` and allow the camera. To create the static web files run `npx expo export -p web` (output in `app/dist`).

## Employee lookup by card number

The backend endpoint `GET /employee/{card_no}` runs the SQL from `EMP_LOOKUP_SQL`. The SQL must:

- filter with the bind variable `:card`
- return exactly these columns in this order: `employee_id`, `employee_name`, `deptt_name`, `section_name`, `designation_name`

Example:

```
EMP_LOOKUP_SQL="SELECT emp_id, emp_name, dept_name, section_name, designation FROM employee_master WHERE card_no = :card"
```

In the app, the details appear about a second after the card number is typed. If the lookup is not configured, the card is not found or the database cannot be reached, the app shows a message and the details can be entered manually.

## Web app notes

- The web app looks like the phone app and works in a desktop browser with a webcam.
- Browsers allow the camera only on `https` pages or on `localhost`. For phones and iPhones the backend must be served over HTTPS (`SERVER_SECURE=true`).
- Differences from the native app: no vibration, the front camera may be mirrored (use `SWAP_WEB_FRONT`), and the update notice is not shown.

## Tuning

Set the mode in `.env` and restart the backend:

```
ENROLL_MODE=balanced
```

| Mode | Behavior |
|---|---|
| `fast` | Captures on the first good frame, small head movements are enough, accepts softer photos |
| `balanced` | Confirms every angle with a second frame and checks photo quality (recommended) |
| `strict` | Needs larger head movements, sharper photos, a closer face and a steady position |

Set `APP_DEBUG=true` to see live values on the camera screen:

```
yaw=3 pitch=-5 dYaw=+18 dPitch=-2 roll=1
size=0.28 sharp=40/22 eyes=0.24 conf=0.90 bright=120
```

`dYaw` is the left/right turn from the front photo in degrees (left is positive), `dPitch` is the up/down tilt (down is positive) and `sharp=40/22` is the photo sharpness and the minimum needed.

Any value can be added to `.env` to override the selected mode (angles are in degrees). The on-screen message tells which check failed.

| Message on screen | Setting | Lower value | Higher value |
|---|---|---|---|
| Hold steady, the image is blurry | `MIN_SHARPNESS`, `SHARP_RATIO` | Accepts softer photos | Rejects blurry photos |
| Move the phone a little closer | `MIN_FACE_SIZE` | Phone can be farther away | Face must be closer |
| Face is not clear or is covered | `MIN_FACE_CONF` | More tolerant | Stricter |
| Keep your eyes open | `MIN_EYE_OPEN` | More tolerant | Stricter |
| Keep your head straight | `MAX_ROLL` | Stricter | More tolerant |
| Too dark / Too bright | `MIN_BRIGHT`, `MAX_BRIGHT` | Accepts darker photos | Allows brighter photos |
| (angle not reached) | `YAW_DELTA`, `PITCH_DELTA` | Less head movement needed | More head movement |
| (angle too extreme) | `YAW_MAX`, `PITCH_MAX` | Rejects large angles earlier | Allows larger angles |
| (drifting while turning) | `CROSS_TOL` | Stricter | More tolerant |
| Hold still | `REQUIRE_STABLE`, `STABLE_TOL` | `false` captures on the first good frame | `true` needs a second matching frame |
| Photo is not clear enough | `PHOTO_MIN_CONF`, `CROP_MARGIN` | Lower score accepted | Larger margin around the face |

## Android test builds (GitHub Actions)

A tag named `test-v<version>` builds a signed APK and attaches it to a GitHub **pre-release**. Pre-releases do not trigger the update notice of the production app.

One-time setup: create the environment `test` in **Settings > Environments** with these values.

| Type | Name | Value |
|---|---|---|
| Secret | `ANDROID_KEYSTORE_BASE64` | The signing keystore as base64 text |
| Secret | `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` | Keystore password |
| Secret | `ANDROID_KEY_ALIAS` | Key alias |
| Secret | `APP_TOKEN` | Token of the test backend |
| Variable | `SERVER_HOST`, `SERVER_PORT`, `SERVER_SECURE` | Address of the test backend |
| Variable | `APP_NAME`, `APP_SLUG`, `ANDROID_PACKAGE`, `IOS_BUNDLE_ID`, `APP_DEBUG` | App identity of the test app |

To build:

```powershell
git checkout test-dev
git tag test-v1.0.1
git push origin test-v1.0.1
```

The build takes about 15 to 25 minutes (see the **Actions** tab). The APK is then in **Releases**. Install it on a phone that can reach the test backend.

Keep the signing keystore and its password safe. Without them new builds cannot be installed over an existing install.

## Security notes

- Never commit `.env`. It is listed in `.gitignore`.
- The enrollment API key exists only in the backend `.env`.
- `APP_TOKEN` is embedded in the app and is only a basic guard. Test APKs on a public repository are downloadable by anyone, so use a separate test token and a test backend only.
- `backend/captures/` contains employee face photos. It is ignored by git and must stay private. Set `SAVE_LOCAL_COPIES=false` when local copies are not needed.
- Use HTTPS / WSS before exposing the backend to the internet.

## Troubleshooting

| Problem | What to check |
|---|---|
| Home shows "Server unreachable" | Backend running? Same network? `SERVER_HOST` and `SERVER_PORT` correct? Firewall rule added? |
| Backend stops with "Missing settings" | `.env` exists in the project root with `ENROLL_URL`, `API_KEY` and `APP_TOKEN` |
| Connection closed right after start | `APP_TOKEN` of the app and of the backend differ. Restart both |
| Web app cannot reach the backend | The page address must be listed in `CORS_ORIGINS` |
| Web camera does not start | Use `localhost` or an HTTPS address, and allow the camera in the browser |
| "Employee lookup is not set up" | Fill `EMP_DB_*` and `EMP_LOOKUP_SQL`, or enter the details manually |
| "No employee found for this card number" | Check the card number and the lookup SQL |
| HTTP 405 from the enrollment API | `ENROLL_URL` must point to the API endpoint, not to the `/docs` page |
| HTTP 422 "expected exactly one detectable face" | That photo was rejected. The app asks for that angle again |
| Left and right are reversed | Set `SWAP_FRONT`, `SWAP_BACK` or `SWAP_WEB_FRONT` to `true` |
| An angle is never captured | Turn on `APP_DEBUG`, compare `dYaw` / `dPitch`, then lower `YAW_DELTA` / `PITCH_DELTA` |
| The test build fails in Actions | Open the failed step in the **Actions** tab. Check the secrets and variables of the `test` environment and that `app/package-lock.json` is committed |

## Roadmap

- Fill in the Oracle details so the card lookup is active
- Login system with a personal account for every operator
- Access from outside the office network (HTTPS) and the iPhone web app
- Attendance screen using the same recognition service

## License

Internal project of SM Foods. Add a license file before sharing the code publicly.