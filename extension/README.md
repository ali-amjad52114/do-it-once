# Do It Once: Teach Mode extension

You do a web chore once in Chrome while this extension watches. It records what you clicked,
what you typed into (the final value only) and what you chose. Do It Once then turns the
recording into a reusable skill that a Kernel browser replays.

It is plain Manifest V3 with vanilla JS. There is no build step and there are no dependencies.

## Load it (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this `extension/` folder.
4. Pin **Do It Once: Teach Mode** from the puzzle-piece menu.

After you edit a file, click the reload icon on the extension card. Then reload the page you
are recording.

## Record a chore

1. Open the page where the chore starts, for example the demo site:
   `PORT=4011 node demo-site/server.mjs`, then open http://localhost:4011/account.
2. Open the popup and click **Start recording**. A "● Recording — Do It Once" pill appears at
   the bottom right of the page, and the toolbar icon shows `REC`.
3. Do the chore as usual. The popup shows a live count of actions and the last 5 in plain
   words, such as `Clicked "Billing"`, `Typed in "Email"` or `Chose "No longer needed"`.
4. Click **Stop**, then either:
   - **Send to Do It Once**, which POSTs the JSON to `{appUrl}/api/teach/recordings`. The app
     URL defaults to `http://localhost:3000` and you can change it under **Settings**. If the
     app answers 404 (the endpoint arrives in Wave B), the popup tells you so and you can
     download the JSON instead; or
   - **Download JSON**, which saves `do-it-once-recording-<startedAt>.json`.
5. **Record again** clears the session.

Recording follows the tab across page loads, redirects and iframes. If the tab is closed, the
recording stops and is kept until you start a new one. The session lives in
`chrome.storage.session`, so it is cleared when the browser quits.

## What is captured

| Action     | When                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `click`    | Clicks on the nearest interactive element: a link, button, `[role]`, checkbox or radio. A click on a `<label>` is recorded on its control. Clicks that only focus a text field are skipped. |
| `type`     | The **final** value of a text field, on change or blur, or after 1.2 s without typing. Repeated edits of the same field are merged into one action. |
| `select`   | The chosen `<option>` label(s).                                                                   |
| `submit`   | A form submit that was **not** caused by clicking its submit button. That click already says what happened. |
| `navigate` | A top-frame URL change that was **not** caused by a click or submit in the last 4 s, for example a typed URL, a bookmark or Back. |

For each element the extension builds a `RecordedTarget`:

- `tag` and `role`. The role is the explicit one if set, otherwise the implicit one: `a[href]`
  is `link`, `<select>` is `combobox`, and so on.
- `name`, the accessible name. It comes from, in order: `aria-labelledby`, `aria-label`, the
  associated `<label>`, `value` (for input buttons), `alt`, the inner text, `title`, then
  `placeholder`.
- `text`, the visible text, up to 80 characters. This is never set for form fields.
- `label`, from the associated `<label>`, `aria-label` or `placeholder`.
- `selector`, a best-effort Playwright selector. It is the first that applies of:
  `role=link[name="Billing"]`, `internal:label="Email"i`, `text="…"`, then `#id`,
  `tag[name="…"]` or the tag name.

## Privacy

- **Keystrokes are never recorded.** Only the value a field ends up with is kept.
- The value is replaced with `"[redacted]"` when any of these is true:
  - the field is `type="password"`;
  - `autocomplete` contains a `cc-*` token, `one-time-code`, `current-password` or
    `new-password`;
  - the field's name, id, label, placeholder or aria-label looks like a password, card number,
    CVV/CVC/CSC, security code, OTP, PIN, SSN, IBAN, routing or account number;
  - the value itself looks like a card number (13 to 19 digits, with or without spaces or
    dashes).
- Form-field values never appear in `target.text`.
- A visible "● Recording — Do It Once" pill is shown on every page while recording. Nothing is
  captured before **Start** or after **Stop**.
- Recordings stay in the browser. They are only sent when you click **Send**, and only to the
  configured app URL.

## JSON format

The JSON matches `Recording` in `lib/contracts.ts`:

```json
{
  "startedAt": "2026-10-04T20:45:20.000Z",
  "endedAt": "2026-10-04T20:46:52.000Z",
  "startUrl": "http://localhost:4011/account",
  "actions": [
    {
      "at": "2026-10-04T20:45:22.022Z",
      "url": "http://localhost:4011/account",
      "pageTitle": "Account · Lumen+",
      "action": "click",
      "target": {
        "tag": "a",
        "role": "link",
        "name": "Billing",
        "text": "Billing",
        "label": null,
        "selector": "role=link[name=\"Billing\"]"
      },
      "value": null
    }
  ]
}
```

`action` is one of `navigate | click | type | select | submit`. `target` is `null` for
`navigate`. `value` is the typed or chosen value, `"[redacted]"` for sensitive fields, and
otherwise `null`.

## Files

| File            | Role                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `manifest.json` | MV3 manifest: popup, service worker, `storage`, `activeTab`, `scripting` and `tabs` permissions. |
| `background.js` | Keeps the session, registers the content scripts while recording, records navigations, merges type actions. |
| `lib.js`        | Pure helpers: role, accessible name, selector, redaction and human wording. Shared by the content script, the popup and the tests. |
| `recorder.js`   | Content script that runs in every frame. It stays idle until the worker confirms this tab is being recorded. |
| `popup.*`       | The "Teach your agent" popup.                                                              |
| `test/`         | `node --test extension/test/` runs the pure helper tests (`node:test`, no dependencies).  |
