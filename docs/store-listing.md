# Chrome Web Store listing

Everything the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) asks for, ready to paste. Upload the ZIP from the GitHub release (`pagewise-v1.0.0.zip`): `manifest.json` is at its root, as the store expects.

Keep this file in step with the code. If permissions, stored data or providers change, update the privacy tab answers here, the [privacy policy](../site/privacy.html) and the dashboard together.

## Store listing tab

**Name:** Pagewise (from `manifest.json`). Search the store first for an existing extension with the same name.

**Summary** (from the manifest's `description`, at most 132 characters):

> A side-panel AI agent that reads, explains, sees, and acts — only with your approval.

**Category:** Productivity. **Language:** English.

**Description:**

```text
Pagewise is an AI helper that lives in Chrome's side panel and understands the page you're on.

READ
• Summarise any article as a TL;DR, five key points and next steps.
• Summarise public YouTube videos with clickable chapter timestamps.
• Answers in English or Hinglish, switched with one click.

CHAT WITH THE PAGE
• Ask follow-up questions. Answers come only from the page, and Pagewise tells you when the page doesn't say.

RIGHT-CLICK
• Select text, right-click: Explain this, Translate (11 languages), or Draft a reply.

SEE
• Capture what's on screen, crop to a chart or table, and ask about it.

ACT, WITH YOU IN CONTROL
• "Find it for me" points at the button or field you describe.
• The agent fills forms and finds information one step at a time. Each step shows what it will do and why, and nothing happens until you press Approve. Skip or Stop at any time.
• Submit, send and delete need a second confirmation. Every step is logged and can be exported.

REMEMBER
• A local profile fills forms and signs your drafted replies.
• One-click skills like "Exam notes", which you can export and share.

SAFE BY DESIGN
• Switched off on banking, payment and UPI pages.
• Private pages (email, documents, messages) are never read; only text you select is sent, after you agree once per site.
• Never types passwords, OTPs or card numbers, and never pays or logs in for you.
• Card, Aadhaar, PAN, OTP and UPI numbers are removed before anything is sent to the AI.

PRIVATE
• Uses your own free Google Gemini API key (optional free Groq key as a backup).
• Your key, profile, skills and logs stay on your computer. No Pagewise server, no analytics, no tracking.

Free and open source: https://github.com/Sreeramaiml/ai-browser
Practice pages to try the agent safely: https://sreeramaiml.github.io/ai-browser/practice/
```

**Graphics:**

| Asset | Size | Source |
|---|---|---|
| Store icon | 128×128 PNG | `assets/icons/128.png` |
| Screenshots (1 to 5) | 1280×800 or 640×400 | Capture per [screenshots/README.md](screenshots/README.md), then place each one on a 1280×800 canvas. Suggested: summary in Hinglish, page chat, approval card with confirmation, the 🔴 blocked page, skills |
| Small promo tile | 440×280 PNG | To make: the icon, the name, and "Read · See · Act, with your approval" |
| Marquee (optional) | 1400×560 PNG | Only needed if the store features it |

**Additional fields:**
- Homepage URL: https://sreeramaiml.github.io/ai-browser/
- Support URL: https://github.com/Sreeramaiml/ai-browser/issues

## Privacy practices tab

**Single purpose:**

> Pagewise helps the user understand and act on the web page they are viewing: it summarises, explains and answers questions about the page, and carries out browser steps on it only after the user approves each one.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `sidePanel` | Pagewise's whole interface is a side panel shown next to the page the user is working on. |
| `storage` | Keeps the user's settings, own API keys, optional profile, saved skills and agent logs locally on their computer. Nothing is synced or sent to the developer. |
| `contextMenus` | Adds the right-click "Pagewise" menu (Explain this, Translate, Draft a reply) for selected text. |
| `scripting` | Injects Pagewise's page reader into the current tab when the user uses a feature: to read the article or selection, number buttons and fields, and type or click only after the user approves a step. |
| `tabs` | Reads the active tab's URL and title so the panel follows the tab the user is viewing, applies its safety rules (for example, switching off on banking sites), and pauses an agent task if the user leaves its tab. |
| `activeTab` | Keeps features working on the current tab when the user invokes Pagewise (toolbar button, right-click menu, Alt+Shift+X), even if they have limited Pagewise's site access to "On click". |
| Host permission `<all_urls>` | Users ask Pagewise about whatever page they are on, so it must be able to read that page's content, capture the visible tab for screenshot questions, and act on forms after approval. It only touches a page when the user uses a feature there, and refuses banking, payment and private pages by design. |
| Host permissions `generativelanguage.googleapis.com`, `api.groq.com` | Sends the user's requests to the AI provider whose API key the user entered (Google Gemini, and optionally Groq). No other server is contacted. |

**Remote code:** No, I am not using remote code. All JavaScript is in the package; the libraries (Readability, marked, DOMPurify) are vendored and pinned.

**Data usage.** Tick each type the extension handles. The dashboard's definitions decide, and you are the one certifying, so read them. These are the recommended, cautious answers:

| Data type | Tick? | Why |
|---|---|---|
| Personally identifiable information | ✅ | The optional profile (name, email, phone, college). Used for form filling and reply sign-offs. |
| Authentication information | ✅ | The user's own Gemini and Groq API keys, stored locally and sent only to their provider. |
| Personal communications | ✅ | When the user selects an email or message and uses Draft a reply or Explain, that text is sent to the AI provider. |
| Website content | ✅ | Page text, titles and screenshots the user asks about are sent to the AI provider. |
| Web history | ✅ | The current page's address is sent with the request when the user uses a feature on it. Pagewise doesn't keep a browsing history. |
| Health information | ☐ | Not collected. Health portals are treated as private pages. |
| Financial and payment information | ☐ | Never collected. Pagewise is switched off on banking and payment pages, and removes card, UPI and PAN numbers from what it sends. |
| Location | ☐ | Not used. |
| User activity | ☐ | No clicks, keystrokes or usage are tracked. Agent logs record only the user's own approved steps and stay on their computer. |

**Certify all three:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

The "approved use case" is sending the user's requests to the AI provider they chose, to provide the feature they asked for.

**Privacy policy URL:** https://sreeramaiml.github.io/ai-browser/privacy.html

## Distribution tab

- **Visibility:** start with **Unlisted**. Install it from the store link with a few testers and run [test-plan.md](test-plan.md) against the store build. Then switch to **Public**.
- **Regions:** all regions.
- **Price:** free.

## Notes for the reviewer

If the dashboard offers a field for test instructions, paste:

```text
Pagewise needs the user's own free Google Gemini API key (https://aistudio.google.com/apikey): open the side panel → ⚙ Settings → paste the key → Save.
To try the agent safely, open https://sreeramaiml.github.io/ai-browser/practice/internship/ and, in the Agent tab, enter:
"Fill this application with name Asha Rao and email asha@example.com, and stop before submitting."
Each step waits for Approve. Safety: https://sreeramaiml.github.io/ai-browser/practice/safety/ shows login, OTP, card and UPI pages that Pagewise refuses.
```

## Each update

1. Bump the version in `manifest.json` and `package.json`, and update `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push; the release workflow builds `pagewise-vX.Y.Z.zip`.
3. Dashboard → Package → Upload new package → that ZIP → Submit for review. Users get it automatically once approved.
4. If permissions or data use changed, update the privacy tab and the privacy policy first.
