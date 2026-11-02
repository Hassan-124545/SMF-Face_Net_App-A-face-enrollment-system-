// Expo configuration. Values come from the shared .env file in the project root
// (or from environment variables when building in the cloud / CI).
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const env = process.env;
const version = env.APP_VERSION || '1.0.0';
const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
const buildNumber = major * 10000 + minor * 100 + patch; // grows with every version
const host = env.SERVER_HOST || '';
const port = env.SERVER_PORT || '';

module.exports = {
  expo: {
    name: env.APP_NAME || 'SM FaceID',
    slug: env.APP_SLUG || 'sm-faceid',
    version,
    orientation: 'portrait',
    userInterfaceStyle: 'automatic', // follow the phone's dark / light mode
    ios: {
      supportsTablet: false,
      bundleIdentifier: env.IOS_BUNDLE_ID || 'com.smfoods.faceid',
      buildNumber: String(buildNumber),
    },
    android: {
      package: env.ANDROID_PACKAGE || 'com.smfoods.faceid',
      versionCode: buildNumber,
    },
    web: { bundler: 'metro', output: 'single' },
    // when the web app is hosted in a sub folder (for example GitHub Pages), set WEB_BASE_URL=/repo-name
    ...(env.WEB_BASE_URL ? { experiments: { baseUrl: env.WEB_BASE_URL } } : {}),
    plugins: [
      ['expo-camera', { cameraPermission: `${env.APP_NAME || 'SM FaceID'} needs camera access to enroll employee faces.` }],
      // allow plain http:// and ws:// to the backend in the Android release APK (not needed with https)
      ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    ],
    extra: {
      server: host ? (port ? `${host}:${port}` : host) : '',
      secure: env.SERVER_SECURE === 'true',
      token: env.APP_TOKEN || '',
      githubRepo: env.GITHUB_REPO || '',
      debug: env.APP_DEBUG === 'true',
    },
  },
};