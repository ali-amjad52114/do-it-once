// Server-only env access. Never import from client components.
export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}
