'use client';
// Client hook: which add-ons are on (from GET /api/addons). All false until loaded.
import { useEffect, useState } from 'react';

export interface AddonFlags {
  judge: boolean;
  mcp: boolean;
  guide: boolean;
  discover: boolean;
}

const OFF: AddonFlags = { judge: false, mcp: false, guide: false, discover: false };
let cache: AddonFlags | null = null;

export function useAddons(): AddonFlags {
  const [flags, setFlags] = useState<AddonFlags>(cache ?? OFF);
  useEffect(() => {
    if (cache) return;
    fetch('/api/addons', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : OFF))
      .then((f: AddonFlags) => {
        cache = f;
        setFlags(f);
      })
      .catch(() => {});
  }, []);
  return flags;
}
