# Pagewise

**A Chrome side-panel assistant that reads the page you're on, explains it, and helps you act on it, one approved step at a time.**

Pagewise summarises articles and YouTube videos in English or Hinglish, answers questions using only what the page says, explains or translates what you select, and reads charts and other content from a screenshot. It can also fill forms and find things for you, but it proposes one step at a time and does nothing until you press **Approve**.

It runs on your own free Gemini API key. Your key, profile and history stay on your computer, and there's no Pagewise server.

![Pagewise summarising an article, then filling a practice form step by step](docs/demo.gif)

## Contents

- [Features](#features)
- [Install](#install)
- [Get a free API key](#get-a-free-api-key)
- [First run](#first-run)
- [Privacy and safety](#privacy-and-safety)
- [Permissions explained](#permissions-explained)
- [Practice site](#practice-site)
- [Limitations](#limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Features

| | |
|---|---|
| **Read** | Summarise the article you're on as a TL;DR, five key points and next steps. Summarise a public YouTube video with clickable chapter timestamps. Switch between English and Hinglish from the panel header. |
| **Chat** | Ask follow-up questions about the page. Answers come only from the page, and Pagewise says so when the page doesn't cover your question. |
| **Right-click** | Select text, right-click, and choose **Explain this**, **Translate**, or **Draft a reply**. Drafts can be made shorter or more formal in one click. |
| **See** | Capture what's on screen, crop to the part you mean, and ask about it, such as a chart, a table or a diagram. |
| **Act** | **Find it for me** points at the button or field you describe. The **agent** carries out a task one step at a time: each step shows what it will do and why, and you **Approve**, **Skip** or **Stop**. Every step goes into a log you can export. |
| **Remember** | A local **profile** fills forms (you see each value before it's typed) and signs your drafted replies. **Skills** are one-click prompt recipes, such as "Exam notes", that you can export and share as a small file. |

| Summary in Hinglish | Page chat | Approving an agent step | Blocked on a bank page |
|---|---|---|---|
| ![Summary card in Hinglish](docs/screenshots/read-summary-hinglish.png) | ![Chat saying the page doesn't cover the question](docs/screenshots/chat-not-found.png) | ![Approval card asking to confirm Submit](docs/screenshots/agent-confirm.png) | ![Red safety badge and blocked message](docs/screenshots/safety-blocked.png) |

## Install

Pagewise is installed from a GitHub release, not the Chrome Web Store. You need Chrome 116 or later on Windows, macOS, Linux or ChromeOS.

1. Download **`pagewise-vX.Y.Z.zip`** from the [latest release](../../releases/latest).
2. Unzip it into a folder you'll keep. Chrome loads Pagewise from that folder, so don't delete it later. Any folder works, including ones with spaces or non-English letters in the path.
3. Open `chrome://extensions` and switch on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder: the one that contains `manifest.json`.

Pin Pagewise from the puzzle-piece menu so its icon is always in the toolbar. Click the icon to open the side panel.

**To update:** download the new ZIP, unzip it over the same folder, and click **Reload** on Pagewise's card in `chrome://extensions`. Your key, profile, skills and logs are kept.

## Get a free API key

Pagewise uses Google's Gemini models through your own free key.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey) and sign in with a Google account.
2. Click **Create API key** and copy it.
3. In Pagewise, open **Settings** (the ⚙ button), paste the key, and click **Save key**. Pagewise tests it straight away.

**Optional: Groq as a backup.** Free keys have per-minute and daily limits. A free [Groq key](https://console.groq.com/keys), saved in the same place, lets text features keep working when Gemini is busy. Screenshots and YouTube summaries still need Gemini.

Keys are stored only on this computer and sent only to Google or Groq. They never appear in logs, exports or skills.

## First run

1. **Add your key** in Settings, as above.
2. Open any article and go to the **Read** tab. Click **Summarise this page**, then flip **EN | Hinglish** in the header.
3. Go to **Chat** and ask something about the page. Try a question the page doesn't answer, too.
4. Select a sentence on the page, right-click, and choose **Pagewise → Explain this**.
5. In **See**, capture the screen, drag to crop a chart, and ask what it shows.
6. Open the [practice site](#practice-site), go to the **Agent** tab, and type: *"Fill this application with name Asha Rao and email asha@example.com, and stop before submitting."* Approve or skip each step as it comes. **Stop** (or `Esc`, or `Alt+Shift+X` from anywhere in Chrome) ends the task at once.
7. Optionally, fill in **Settings → Profile** and try the **Skills** tab's "Fill this form from my profile".

## Privacy and safety

Pagewise keeps you in control. These rules are enforced in code, not just requested from the AI model.

**Nothing happens without you.** The agent proposes one step at a time and waits for **Approve**. Anything that submits, sends or deletes needs a second confirmation. It only acts on the practice site and on sites you add under **Settings → Safety → Your own sites**.

**Pages are sorted by sensitivity.** A badge in the panel header shows how Pagewise treats the page you're on:

| Badge | Pages | What Pagewise does |
|---|---|---|
| 🟢 | Ordinary public pages: news, blogs, docs, YouTube | Everything works. |
| 🟡 | Private pages: email, documents, messaging, government ID and health portals, and any page with a login form | Won't read the page or take screenshots. Right-click actions still work on text you select, after you agree once per site, and then **only the selected text** is sent. |
| 🔴 | Banking, payments, UPI and checkout pages, pages asking for card, UPI or OTP details, and sites you block | Switched off completely, with no override. |

**Some actions are never taken for you.** Pagewise never types into password, OTP or card fields, never types something that looks like a card, Aadhaar or OTP number, and never clicks pay, checkout or log-in buttons.

**Sensitive numbers are removed before anything is sent.** Card numbers, Aadhaar, PAN, OTPs, UPI IDs and API keys are replaced with placeholders such as `[card number removed]` before any text goes to the AI. You can also hide emails and phone numbers in **Settings → Safety**.

**Your data stays on your computer.** Your key, profile, skills, settings and agent logs live in Chrome's local extension storage and are never synced. Page text and screenshots are sent only to the AI provider, and only for the feature you asked for. There is no analytics, no telemetry and no Pagewise server. **Settings → Clear all my data** deletes everything.

**Page content is treated as untrusted.** Text from web pages is clearly marked as data for the model, and instructions hidden inside it are ignored. Even if a page tricks the model, the worst it can do is *propose* a step, which still has to pass the safety rules and your approval.

## Permissions explained

Chrome shows these when you install Pagewise.

| Permission | Why Pagewise needs it |
|---|---|
| **Read and change all your data on all websites** (`<all_urls>`) | To read the page you ask about, capture the screen, and highlight or fill fields when you approve a step, on whatever site you're on. Pagewise only looks at a page when you use a feature on it. A narrower, per-site permission is planned (see [Limitations](#limitations)). |
| `sidePanel` | To show Pagewise next to the page. |
| `tabs`, `activeTab` | To know which page is open, so the panel header and features follow the tab you're looking at. |
| `scripting` | To add Pagewise's page reader and helpers to a page when you use a feature there. |
| `contextMenus` | For the right-click **Pagewise** menu. |
| `storage` | To keep your key, profile, skills, settings and logs on this computer. |
| `generativelanguage.googleapis.com`, `api.groq.com` | To call Gemini, and Groq if you add a backup key. Pagewise talks to no other server. |

Pagewise is not allowed in Incognito windows.

## Practice site

The practice site has fake pages for trying the agent safely: a three-step internship application, a gadget shop, a club directory, and login, OTP, card and UPI pages that Pagewise must refuse. Nothing you type there is sent anywhere.

- **Online:** it's published with this project's GitHub Pages site, under `/practice/`.
- **On your computer:** from a clone of this repository, run `npx serve practice` and open http://localhost:3000.

## Limitations

- **Free-tier limits.** Free Gemini keys have per-minute and daily quotas. Pagewise paces its requests, waits out short limits, and can fall back to Groq for text, but heavy use can still hit the daily cap.
- **YouTube** summaries work for public videos that Gemini accepts. Private, age-restricted, region-locked and very long videos can't be summarised.
- **The agent** works on ordinary web forms. It can't reach inside frames from other sites or canvas-drawn apps, and a few sites ignore the simulated typing and clicks it uses. It never uploads files: it highlights the upload field for you.
- **The sensitive-site lists** can't cover every bank or private site. Page signals (card, OTP and login fields) and your own blocklist fill the gaps.
- **Your API key** is stored unencrypted in Chrome's extension storage on this computer, as with most extensions without a backend.
- **The interface is in English.** Answers can be in English or Hinglish, and Translate covers 11 languages.
- **Broad site access.** Pagewise asks for access to all sites, which is simpler and more reliable for v1. Narrower per-site permissions, and a Chrome Web Store listing, may follow.

## Development

Pagewise is plain JavaScript (ES2022 with JSDoc types) with no build step. Node.js 22 or later is needed for the tests and release tooling only.

```bash
git clone <this repository> pagewise && cd pagewise
npm install          # dev tools only: Vitest and happy-dom
npm test             # unit tests (npm run test:safety runs the safety suite alone)
npx serve practice   # practice site on http://localhost:3000
```

Then load the repository folder itself with **Load unpacked**. After changing the service worker or `manifest.json`, click **Reload** on `chrome://extensions`. After changing the side panel, close and reopen it. After changing a content script, reload the extension and the page.

- **Safety rules shared with the page:** `src/shared/safety/field-rules.js` and `action-rules.js` are copied into classic scripts for content scripts. Run `npm run sync` after editing them; CI fails if the copies are out of date.
- **Release ZIP:** `npm run package` writes `dist/pagewise-v<version>.zip`, and `node scripts/package.mjs --check` runs the checks without writing. Pushing a `v*` tag builds and publishes a GitHub Release (see [CHANGELOG.md](CHANGELOG.md)).
- **Secret scanning:** CI runs [gitleaks](https://github.com/gitleaks/gitleaks) over the whole history. `npm run hooks` turns on an optional pre-commit check.

Design documents: [problem statement](docs/problemstatement.md), [architecture](docs/architecture.md), [implementation plan](docs/implementation-plan.md), [edge cases](docs/edge-case.md), and the [manual test plan](docs/test-plan.md).

## Contributing

Issues and pull requests are welcome.

- Keep changes small, with tests. Pure modules (safety rules, validators, prompt builders) get Vitest tests in the same change.
- Never commit an API key. Keys belong in the extension's Settings only. Test fixtures build fake keys at runtime, for example `'AIza' + 'x'.repeat(35)`.
- Changes to safety rules need table-driven tests, including Indian cases such as a postal "PIN code" versus an OTP PIN, UPI IDs, and Aadhaar spacing.
- Before a release, go through [docs/test-plan.md](docs/test-plan.md) in a fresh Chrome profile.

## License

[MIT](LICENSE). Vendored libraries (Readability, marked and DOMPurify) keep their own licenses; see [vendor/README.md](vendor/README.md).
