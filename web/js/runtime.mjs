export function isCloudRuntime() {
  return globalThis.CADENCE_RUNTIME?.mode === 'cloud';
}
