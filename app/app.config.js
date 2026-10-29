// Expo configuration. Values come from the shared .env file in the project root.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const env = process.env;
const version = env.APP_VERSION || '1.0.0';
const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
const buildNumber = major * 10000 + minor * 100 + patch; // grows with every version

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
    plugins: [
      ['expo-camera', { cameraPermission: `${env.APP_NAME || 'SM FaceID'} needs camera access to enroll employee faces.` }],
    ],
    extra: {
      server: env.SERVER_HOST ? `${env.SERVER_HOST}:${env.SERVER_PORT || '8005'}` : '',
      token: env.APP_TOKEN || '',
      githubRepo: env.GITHUB_REPO || '',
      debug: env.APP_DEBUG === 'true',
    },
  },
};
