---
name: kernel
description: Use for anything touching browser automation via Kernel (kernel.sh / onkernel cloud browsers) in "Do It Once" - creating/deleting remote browsers, connecting Playwright over CDP, server-side playwright.execute, clicking/typing/extracting/screenshots, embedding the live view iframe, persisting logins with profiles, recording replays, downloading files, and replaying learned chores against /demo-membership or real sites.
---

# Kernel (cloud browsers) - "Do It Once" skill

Kernel = "the hands". It runs sandboxed Chromium in the cloud; our Mastra workflows drive it
via Playwright (CDP or server-side execution), show it to the user via the live view iframe,
and persist login state via profiles.

Based on Kernel's official skill `kernel-typescript-sdk` (github.com/kernel/skills,
`plugins/kernel-sdks/skills/kernel-typescript-sdk/SKILL.md`, commit 6571289, 2026-09-30),
plus the docs and SDK type definitions listed at the bottom. Checked 2026-10-04.

## Install and env

```bash
npm install @onkernel/sdk          # verified latest: 0.119.0 (published 2026-10-02)
npm install playwright-core        # only needed for the CDP path
```

- Env var: `KERNEL_API_KEY` (SDK reads it automatically). Get a key at the Kernel dashboard.
- Server-only. Never import `@onkernel/sdk` in client components or expose the key via `NEXT_PUBLIC_*`.
  Call Kernel from Next.js route handlers / server actions / Mastra tools.
- Both imports work: `import Kernel from "@onkernel/sdk"` and `import { Kernel } from "@onkernel/sdk"`.
- Client options: `apiKey`, `maxRetries` (default 2), `timeout` (ms, default 60000), `logLevel`.
- Request/response fields are `snake_case` (`session_id`, `cdp_ws_url`, `timeout_seconds`);
  methods are camelCase (`deleteByID`, `captureScreenshot`).
- Errors: `APIError` subclasses (`AuthenticationError` 401, `NotFoundError`, `ConflictError` 409,
  `RateLimitError` 429, `APIConnectionTimeoutError`, ...) exported from `@onkernel/sdk`.

## Localhost is NOT reachable

Kernel browsers run in Kernel's cloud, so `http://localhost:3000/demo-membership` will not load
(inferred from the architecture; the docs do not state it explicitly). Expose the demo site via:
- the deployed Fly.io app (`fly.toml` exists in this repo) - preferred for the demo, or
- a public tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`, or ngrok) during dev.
Keep the base URL in an env var such as `DEMO_SITE_URL` (project convention, not a Kernel var).

## Create -> connect Playwright (CDP) -> act -> cleanup

```typescript
import Kernel from "@onkernel/sdk";
import { chromium } from "playwright-core";

const kernel = new Kernel(); // reads KERNEL_API_KEY

const session = await kernel.browsers.create({
  stealth: true,          // ISP proxy + auto CAPTCHA solver (see gotchas)
  timeout_seconds: 300,   // idle timeout; default 60, max 72h
  // headless: false (default) -> live view + replays available
  // viewport: { width: 1280, height: 800 },
  // start_url: `${process.env.DEMO_SITE_URL}/demo-membership`,
});
// session.session_id, session.cdp_ws_url, session.browser_live_view_url (optional field)

try {
  const browser = await chromium.connectOverCDP(session.cdp_ws_url);
  try {
    // Reuse the existing default context/page; do not create a new context
    // (a new context would not carry profile cookies or show in live view as expected).
    const context = browser.contexts()[0];
    if (!context) throw new Error("Kernel browser has no default context");
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(`${process.env.DEMO_SITE_URL}/demo-membership`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Email").fill("demo@example.com");
    await page.getByRole("button", { name: "Cancel membership" }).click();
    await page.waitForSelector("text=Cancelled", { timeout: 15_000 });   // verify state
    const status = await page.locator("[data-testid=status]").innerText(); // extract text
    const png = await page.screenshot();                                  // Buffer
  } finally {
    await browser.close(); // closes the CDP client only - does NOT delete the Kernel browser
  }
} finally {
  await kernel.browsers.deleteByID(session.session_id); // always; also triggers profile save
}
```

## Server-side Playwright (preferred by Kernel for agents)

Code runs in the browser VM, no local Playwright needed, lower latency. Each call is a fresh
execution context (`page`, `context`, `browser` are in scope); use `return` to get data back.

```typescript
const res = await kernel.browsers.playwright.execute(session.session_id, {
  code: `
    await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" });
    return { title: await page.title(), text: await page.locator("main").innerText() };
  `,
  timeout_sec: 60,
});
if (!res.success) throw new Error(res.error ?? res.stderr ?? "playwright.execute failed");
console.log(res.result);
```

Do not return screenshots/binary from `execute`; use `computer.captureScreenshot` or `fs.readFile`.
Good fit for an LLM "browser tool" in Mastra; CDP fits deterministic replay of recorded steps.

## Computer controls (OS-level, no CDP)

All take the session id first. Verified in SDK 0.119.0 types:
`captureScreenshot(id, { region? })` -> `Response`, `clickMouse(id, { x, y })`,
`typeText(id, { text })`, `pressKey`, `scroll`, `moveMouse`, `dragMouse`, `getMousePosition`,
`readClipboard`, `setCursorVisibility`, `batch`. Param details beyond those shown: check SDK types.

```typescript
const shot = await kernel.browsers.computer.captureScreenshot(session.session_id);
const buf = Buffer.from(await shot.arrayBuffer()); // PNG bytes -> store / send to vision model
await kernel.browsers.computer.clickMouse(session.session_id, { x: 420, y: 280 });
await kernel.browsers.computer.typeText(session.session_id, { text: "hello" });
```

## Live view (embed in our UI)

- `session.browser_live_view_url` - embeddable in an iframe. Not available for `headless: true`.
- Append `?readOnly=true` for watch-only (e.g. while the agent replays).
- Toggle read-only without reload:
  `iframe.contentWindow.postMessage({ type: "KERNEL_SET_READ_ONLY", readOnly: true }, "*")`.
- `kiosk_mode: true` on create hides browser chrome (causes a Chromium restart, several seconds).
- URL dies when the browser is deleted. A connected live-view viewer keeps the browser out of standby.
- If we set a CSP, allow frames and WebSockets to `*.onkernel.com` and `*.kernel.sh`.
- Viewer emits a `KERNEL_PLAYING` event when started (exact message shape: UNVERIFIED).

```tsx
<iframe
  src={`${liveViewUrl}${readOnly ? "?readOnly=true" : ""}`}
  allow="autoplay; clipboard-read; clipboard-write"
  className="w-full aspect-video border-0"
/>
```

Use it for "let the user log in themselves" (interactive) then hand control back to the agent.

## Profiles (persist login / session state)

Profiles store cookies, auth and site state across browsers. Create once, then attach.

```typescript
import Kernel, { ConflictError } from "@onkernel/sdk";

try { await kernel.profiles.create({ name: `user-${userId}-netflix` }); }
catch (e) { if (!(e instanceof ConflictError)) throw e; } // already exists

// Writer session (e.g. user logs in via live view): saves on delete/timeout
const s1 = await kernel.browsers.create({
  profile: { name: `user-${userId}-netflix`, save_changes: true },
  stealth: true,
});
// ... user logs in ... then:
await kernel.browsers.deleteByID(s1.session_id); // <- this persists the profile

// Replay session (read-only load of saved state)
const s2 = await kernel.browsers.create({ profile: { name: `user-${userId}-netflix` } });
```

- `profile` accepts `{ id?, name?, save_changes? }`. Prefer `id` for long-running work; don't
  rename a profile while a browser references it by name.
- Saving happens ONLY on `deleteByID` or timeout, never on Playwright `browser.close()`.
- Only one writer at a time: saves replace the whole snapshot, no merging.
- Other methods: `profiles.retrieve/list/update/delete/download`.
- Store the profile id/name per user+site in Neon; never store site passwords ourselves.
- Kernel also has Managed Auth (`kernel.auth.connections.create/login/retrieve/submit/follow`)
  that logs in via a hosted page into a profile. Optional; 3 connections on the free plan.

## Replays (video recordings) - headful only

```typescript
const { replay_id } = await kernel.browsers.replays.start(session.session_id); // opts: { framerate?, max_duration_in_seconds?, record_audio? }
// ... run the chore ...
await kernel.browsers.replays.stop(replay_id, { id_or_name: session.session_id });
const replays = await kernel.browsers.replays.list(session.session_id);
const viewUrl = replays.find(r => r.replay_id === replay_id)?.replay_view_url; // iframe-able
const mp4 = await kernel.browsers.replays.download(replay_id, { id_or_name: session.session_id }); // Response
```

Note: the official skill example passes `{ id: ... }` to `replays.stop`; SDK 0.119.0 types require
`{ id_or_name }`. Use `id_or_name`. Stop the replay BEFORE `deleteByID`. Retention: 1 day on free plan.
Replays are video only - our "learned chore" must be stored as structured steps in Neon.

## Files and downloads

Browser VM filesystem: `kernel.browsers.fs.readFile(id, { path })` -> `Response`, plus
`listFiles`, `fileInfo`, `writeFile`, `upload`, `uploadZip`, `downloadDirZip`, `createDirectory`,
`deleteFile`, `move`. For downloads, set CDP `Browser.setDownloadBehavior` (`behavior: "default"`,
`eventsEnabled: true`), read `filePath` from the `downloadProgress` event, then poll `listFiles`
(file appears with a short delay) before `readFile`. Files vanish when the session is deleted.

## Gotchas

1. Always `try/finally` + `kernel.browsers.deleteByID(session_id)`. `browser.close()` is not cleanup.
2. Default idle timeout is 60s. Standby starts 5s after no CDP client, no live-view viewer and
   no computer-control call; the timeout counts from there. Set `timeout_seconds` (e.g. 300-900)
   when a human may pause mid-flow (login, 2FA).
3. `headless: true` = no live view, no replays (~1 GB vs ~8 GB RAM, ~8x cheaper). Use headful for the demo.
4. `stealth: true` routes traffic through a Kernel ISP proxy and auto-solves CAPTCHAs. Fine for
   real sites; for our own demo site it is unnecessary. To go direct on a running stealth session:
   `kernel.browsers.update(id, { proxy_id: "", disable_default_proxy: true })`.
5. Always reuse `browser.contexts()[0]` over CDP; a new context loses profile state.
6. Free (Developer) plan: $5/mo credits, 5 concurrent browsers, replays kept 1 day.
   Headful ~ $0.00013/s (~$0.48/h), headless ~ $0.0000167/s; standby is not billed.
7. Other create params (SDK types): `name`, `region` (`us-east|eu-west|ap-southeast`, paid),
   `gpu` (paid), `proxy_id`, `extensions`, `tags`, `invocation_id` (Kernel apps).
8. Kernel "apps"/actions (`kernel.app("x").action(...)`, `kernel deploy`, `kernel invoke`) let you
   host automation on Kernel. Not needed for us - Mastra on Fly.io calls the SDK directly.

## Replay-with-AI-fallback pattern (project design, not a Kernel API)

1. Load chore steps from Neon (selector/role-based actions + expected checks).
2. Create browser with the user's profile; show live view (`readOnly=true`).
3. Run steps via CDP Playwright; after each, verify the expected state.
4. On failure: capture screenshot + `page.content()`/accessibility snapshot, ask the LLM for the
   next action, execute it, and record the repaired step back to Neon.
5. Stop replay, `deleteByID` in `finally`; store replay URL + outcome in Neon.

## Sources (checked 2026-10-04)

- Official skill: https://github.com/kernel/skills (kernel-sdks/kernel-typescript-sdk, kernel-cli refs);
  catalog https://skills.sh/kernel ; install for Claude Code: `/plugin marketplace add kernel/skills`
  then `/plugin install kernel-sdks`
- Docs index: https://www.kernel.sh/docs/llms.txt
- https://kernel.sh/docs/introduction/create.md , /introduction/control.md
- https://kernel.sh/docs/browsers/live-view.md , /browsers/termination.md , /browsers/headless.md
- https://kernel.sh/docs/browsers/profiles/save-and-reuse.md , /browsers/replays.md
- https://kernel.sh/docs/browsers/bot-detection/stealth.md , https://www.kernel.sh/docs/browsers/file-io
- https://kernel.sh/docs/info/pricing.md
- SDK: https://github.com/kernel/kernel-node-sdk , npm `@onkernel/sdk` 0.119.0 (`.d.ts` inspected)
