const {
  AndroidConfig,
  withAndroidManifest,
  withInfoPlist,
  withProjectBuildGradle
} = require('expo/config-plugins');

const { getMainActivityOrThrow } = AndroidConfig.Manifest;

function ensureUsesPermission(manifest, name, attrs = {}) {
  manifest['uses-permission'] ??= [];
  const existing = manifest['uses-permission'].find(
    permission => permission.$?.['android:name'] === name
  );
  if (existing) {
    existing.$ = { ...existing.$, ...attrs };
  } else {
    manifest['uses-permission'].push({ $: { 'android:name': name, ...attrs } });
  }
}

function ensureUsesFeature(manifest, name) {
  manifest['uses-feature'] ??= [];
  if (
    !manifest['uses-feature'].some(
      feature => feature.$?.['android:name'] === name
    )
  ) {
    manifest['uses-feature'].push({
      $: { 'android:name': name, 'android:required': 'false' }
    });
  }
}

function ensureUsbMetadata(activity) {
  activity['intent-filter'] ??= [];
  const action = 'android.hardware.usb.action.USB_DEVICE_ATTACHED';
  if (
    !activity['intent-filter'].some(filter =>
      filter.action?.some(item => item.$?.['android:name'] === action)
    )
  ) {
    activity['intent-filter'].push({
      action: [{ $: { 'android:name': action } }]
    });
  }

  activity['meta-data'] ??= [];
  const existing = activity['meta-data'].find(
    item => item.$?.['android:name'] === action
  );
  if (existing) return;
  activity['meta-data'].push({
    $: {
      'android:name': action,
      'android:resource': '@xml/jade_device_filter'
    }
  });
}

module.exports = function withBitcoinerlabJadeReactNative(config) {
  config = withInfoPlist(config, config => {
    config.modResults.NSBluetoothAlwaysUsageDescription ??=
      'Connect to your Blockstream Jade over Bluetooth.';
    return config;
  });

  config = withProjectBuildGradle(config, config => {
    if (!config.modResults.contents.includes('https://jitpack.io')) {
      const repositories = /allprojects\s*\{\s*repositories\s*\{/;
      if (repositories.test(config.modResults.contents)) {
        config.modResults.contents = config.modResults.contents.replace(
          repositories,
          match => `${match}\n        maven { url 'https://jitpack.io' }`
        );
      } else {
        config.modResults.contents += `\nallprojects {\n  repositories {\n    maven { url 'https://jitpack.io' }\n  }\n}\n`;
      }
    }
    return config;
  });

  return withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest;
    ensureUsesPermission(manifest, 'android.permission.BLUETOOTH', {
      'android:maxSdkVersion': '30'
    });
    ensureUsesPermission(manifest, 'android.permission.BLUETOOTH_ADMIN', {
      'android:maxSdkVersion': '30'
    });
    ensureUsesPermission(manifest, 'android.permission.ACCESS_FINE_LOCATION', {
      'android:maxSdkVersion': '30'
    });
    ensureUsesPermission(manifest, 'android.permission.BLUETOOTH_SCAN', {
      'android:usesPermissionFlags': 'neverForLocation'
    });
    ensureUsesPermission(manifest, 'android.permission.BLUETOOTH_CONNECT');
    ensureUsesFeature(manifest, 'android.hardware.bluetooth_le');
    ensureUsesFeature(manifest, 'android.hardware.usb.host');
    ensureUsbMetadata(getMainActivityOrThrow(config.modResults));
    return config;
  });
};
