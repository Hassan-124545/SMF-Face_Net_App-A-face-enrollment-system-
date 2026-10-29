# SM FaceID

Mobile face enrollment for employee attendance. An Android and iOS app (React Native / Expo) guides the person through a live multi-angle face capture, and a Python backend validates every photo in real time before sending the enrollment to the company enrollment API.

## Features

- Guided capture of five angles: front, left, right, up and down
- Live feedback over WebSocket: the on-screen frame turns green when the position is right and red when it is not
- Works with both the front and the back camera
- Head angles are measured in degrees from the 3D face mesh, relative to the front photo
- Photo quality checks: blur, brightness, open eyes, straight head, clear (uncovered) face, face size and position
- Each angle is confirmed by two steady frames and the sharper one is kept
- Only the face area is cropped, saved and sent. Every crop is checked to contain exactly one detectable face
- If the enrollment API rejects the photo of one angle, only that angle is retaken
- Three difficulty modes (`fast`, `balanced`, `strict`) selected with one line in `.env`
- Employee form with required fields and enrollment history on the device
- Central configuration in a single `.env` file (no secrets in the code)
- In-app update notice when a newer GitHub release is available

## How it works

```
+--------------+   WebSocket (frames)    +-----------------------+   HTTP + API key   +----------------+
| Mobile app   | ----------------------> | Python backend        | -----------------> | Enrollment API |
| (Expo)       | <---------------------- | (FastAPI + MediaPipe) |                    | (Oracle)       |
+--------------+   guidance and status   +-----------------------+                    +----------------+
```

1. The app streams small camera frames to the backend.
2. The backend finds the face, measures the head angle and photo quality, and replies with the next instruction.
3. When all five angles are captured, the backend uploads the face crops with the employee details to the enrollment API.

## Repository structure

```
.
├── .env.example          Template for the configuration file
├── .gitignore
├── README.md
├── backend/
│   ├── main.py           FastAPI app, quality checks and WebSocket enrollment flow
│   ├── config.py         Loads settings and difficulty presets from .env
│   └── requirements.txt
└── app/
    ├── App.js            All screens of the mobile app
    ├── app.config.js     Expo configuration (reads .env)
    └── package.json
```

## Requirements

- Python 3.11
- Node.js 18 or newer
- A phone with the Expo Go app (for development) on the same WiFi network as the backend PC
- Access to the enrollment API and its API key

## Setup

### 1. Configure

Copy the template and fill in your own values:

```powershell
copy .env.example .env
```

| Variable | Description |
|---|---|
| `ENROLL_URL` | Full URL of the enrollment API endpoint |
| `API_KEY` | API key for the enrollment API (stays on the backend only) |
| `APP_TOKEN` | Shared token the app sends to the backend |
| `SERVER_HOST` / `SERVER_PORT` | Address of the PC that runs the backend |
| `APP_NAME`, `APP_SLUG` | App name and Expo slug |
| `APP_VERSION` | App version (for example `1.0.0`). Bump this for every release |
| `ANDROID_PACKAGE`, `IOS_BUNDLE_ID` | Unique application identifiers |
| `GITHUB_REPO` | https://github.com/zain7413-cmd/SMF-Face_Net_App-A-face-enrollment-system-.git, used for the update notice |
| `APP_DEBUG` | `true` shows live measurements on the camera screen |
| `ENROLL_MODE` | `fast`, `balanced` or `strict` (see [Tuning](#tuning)) |
| `SWAP_FRONT`, `SWAP_BACK` | Set to `true` if left and right are reversed for that camera |
| `CROP_FACES`, `CROP_MARGIN`, `CROP_MAX_SIZE` | Face cropping of the saved and uploaded photos |
| `PHOTO_MIN_CONF`, `VERIFY_TRIES`, `MAX_RETRIES` | Single-face check of the crops and retakes after a server rejection |

Restart the backend after changing the tuning values, and restart the app (`npx expo start -c`) after changing anything else.

### 2. Run the backend

```powershell
cd backend
python -m venv venv
.\venv\Scripts\activate
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8005
```

The console prints the active enrollment mode on start. Open `http://localhost:8005/health` to check that the backend is running. Allow the port in the Windows firewall if the phone cannot reach it:

```powershell
netsh advfirewall firewall add rule name="faceid-8005" dir=in action=allow protocol=TCP localport=8005
```

### 3. Run the app

```powershell
cd app
npm install
npx expo start -c
```

Scan the QR code with Expo Go. The home screen shows **Server connected** when the phone can reach the backend.

## Using the app

1. Tap **New Enrollment** and fill in the employee ID, card number and name.
2. Tap **Start Face Capture** and follow the instructions at the bottom of the screen.
3. Keep the face inside the frame. When it turns green, hold the position until the angle is captured.
4. After the fifth angle the face photos are uploaded and the result is shown.

The camera can be switched with **Flip** before the first angle is captured.

## Tuning

### Choose a mode

Set one line in `.env` and restart the backend:

```
ENROLL_MODE=balanced
```

| Mode | Behavior | Use when |
|---|---|---|
| `fast` | Captures on the first good frame, small head movements are enough, accepts softer photos | Testing, or speed matters more than photo quality |
| `balanced` | Confirms every angle with a second frame and checks photo quality | Normal daily use (recommended) |
| `strict` | Needs larger head movements, sharper photos, a closer face and a steady position | Best possible enrollment quality |

### Reading the debug values

Set `APP_DEBUG=true` and restart the app. The camera screen then shows two lines:

```
yaw=3 pitch=-5 dYaw=+18 dPitch=-2 roll=1
size=0.28 sharp=40/22 eyes=0.24 conf=0.90 bright=120
```

- `dYaw` is the left/right turn from the front photo in degrees (left is positive, right is negative).
- `dPitch` is the up/down tilt from the front photo in degrees (down is positive, up is negative).
- `sharp=40/22` is the photo sharpness and the minimum needed.

### Fine tuning

Any value below can be added to `.env` to override the selected mode. The on-screen message tells which check failed. Angles are in degrees.

| Message on screen | Setting | Lower value | Higher value |
|---|---|---|---|
| Hold steady, the image is blurry | `MIN_SHARPNESS`, `SHARP_RATIO` | Accepts softer photos | Rejects blurry photos |
| Move the phone a little closer | `MIN_FACE_SIZE` | Phone can be farther away | Face must be closer |
| Face is not clear or is covered | `MIN_FACE_CONF` | More tolerant | Stricter about covered faces |
| Keep your eyes open | `MIN_EYE_OPEN` | More tolerant of half-closed eyes | Stricter |
| Keep your head straight | `MAX_ROLL` | Stricter | More tolerant |
| Too dark / Too bright | `MIN_BRIGHT`, `MAX_BRIGHT` | Lower accepts darker photos | Higher allows brighter photos |
| (angle not reached) | `YAW_DELTA` | Less head turn for left and right | More head turn |
| (angle not reached) | `PITCH_DELTA` | Less tilt for up and down | More tilt |
| (angle too extreme) | `YAW_MAX`, `PITCH_MAX` | Rejects large angles earlier | Allows larger angles |
| (drifting while turning) | `CROSS_TOL` | Stricter | More tolerant |
| Hold still | `REQUIRE_STABLE`, `STABLE_TOL` | `false` captures on the first good frame | `true` needs a second matching frame |
| Photo is not clear enough | `PHOTO_MIN_CONF`, `CROP_MARGIN` | Lower score accepted | Larger margin around the face |

### Saved photos

Captured photos are saved on the backend in `backend/captures/<employee_id>/` and are the same images that are sent to the enrollment API. By default only the face is cropped (a square with `CROP_MARGIN` extra space, at most `CROP_MAX_SIZE` pixels). Set `CROP_FACES=false` to use the full camera frame instead.

On Android the app picks a camera photo size of about 1600 px (`TARGET_PHOTO_SIDE` in `app/App.js`), which keeps uploads fast, especially on the back camera.

## Releases and updates

The app shows an update banner when the latest GitHub release has a higher version than the installed one.

To publish a new version:

1. Change `APP_VERSION` in `.env` (for example `1.0.0` to `2.0.0`).
2. Build the app (see below).
3. On GitHub open **Releases**, create a release with the tag `v2.0.0` and attach the Android `.apk` file.

Users with an older version will see **Update available** on the home screen; the button opens the APK download. The repository must be public for the app to read the latest release.

### Building an Android APK

```powershell
cd app
npm install -g eas-cli
eas login
eas build -p android --profile preview
```

For a release APK that talks to the backend over plain `ws://` on a local network, add the Expo build properties plugin and allow cleartext traffic:

```powershell
npx expo install expo-build-properties
```

Then add this entry to the `plugins` list in `app/app.config.js`:

```javascript
['expo-build-properties', { android: { usesCleartextTraffic: true } }],
```

iOS builds require an Apple Developer account and are distributed through TestFlight or the App Store.

## Security notes

- Never commit `.env`. It is listed in `.gitignore`.
- The enrollment API key exists only in the backend `.env`. It is never sent to the app.
- `APP_TOKEN` is embedded in the app and is only a basic guard. Run the backend on a trusted network or behind a VPN, and use HTTPS/WSS if it is exposed to the internet.
- `backend/captures/` contains employee face photos. It is ignored by git and must stay private.

## Troubleshooting

| Problem | What to check |
|---|---|
| Home shows "Server unreachable" | Backend running? Same WiFi? `SERVER_HOST` and port correct? Firewall rule added? |
| Backend stops with "Missing settings" | `.env` exists in the project root with `ENROLL_URL`, `API_KEY` and `APP_TOKEN` |
| Backend stops with "ENROLL_MODE must be one of" | Use `fast`, `balanced` or `strict` |
| Connection closed right after start | `APP_TOKEN` differs between the backend run and the app. Restart both |
| HTTP 405 from the enrollment API | `ENROLL_URL` must point to the API endpoint, not to the `/docs` page |
| HTTP 422 "expected exactly one detectable face" | The server rejected that photo. The app asks for that angle again. If it keeps happening, tilt the head less, or raise `CROP_MARGIN` |
| Left and right are reversed | Set `SWAP_FRONT` or `SWAP_BACK` to `true` |
| An angle is never captured | Turn on `APP_DEBUG`, compare `dYaw` / `dPitch` with the needed values, then lower `YAW_DELTA` / `PITCH_DELTA` |
| Blurry or wrong photos are accepted | Use `ENROLL_MODE=strict`, or raise `MIN_SHARPNESS`, `SHARP_RATIO`, `YAW_DELTA`, `PITCH_DELTA` |
| The enrollment API rejects cropped photos | Set `CROP_FACES=false`, or increase `CROP_MARGIN` |

## Roadmap

- Automatic filling of employee details from the card number
- Attendance screen using the same recognition service
- HTTPS / WSS support and a production deployment guide

## License

Internal project of SM Foods. Add a license file before sharing the code publicly.