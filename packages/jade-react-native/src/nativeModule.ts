import type { JadeNativeModule } from './types.js';

const MODULE_NAME = 'BitcoinerlabJade';

type ExpoModulesRequire = (specifier: string) => {
  requireNativeModule?: (moduleName: string) => unknown;
};

declare const require: ExpoModulesRequire;

export function getJadeNativeModule(): JadeNativeModule {
  try {
    const nativeModule =
      require('expo-modules-core').requireNativeModule?.(MODULE_NAME);
    if (nativeModule) return nativeModule as JadeNativeModule;
  } catch {}
  throw new Error(
    `${MODULE_NAME} native module is unavailable; use a custom React Native build, not Expo Go`
  );
}
