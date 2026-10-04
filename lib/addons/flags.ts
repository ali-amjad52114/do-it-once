// Add-on feature flags. All default OFF: with every flag off the app behaves exactly as before.
export type AddonFlag = 'ADDON_JUDGE' | 'ADDON_MCP' | 'ADDON_GUIDE' | 'ADDON_DISCOVER';

export function flag(name: AddonFlag): boolean {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'on';
}
