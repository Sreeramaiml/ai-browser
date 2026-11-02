# Screenshots and demo: capture guide

The README and the landing page use the images listed below. They have to be real captures of Pagewise running in Chrome, so they're taken by hand. Until a file exists, the README shows a broken image in its place and the landing page leaves that screenshot out.

Save each image here, in `docs/screenshots/`, with exactly the file name given. The demo GIF goes in `docs/demo.gif`. The Pages workflow copies them all to the published site.

## Before you start

- **Use a separate Chrome profile** with no other extensions, bookmarks bar off, and Chrome's default light theme. Set the side panel to about **400 px wide**.
- **Never show real personal data** (EC-REL-09). Fill **Settings → Profile** with the practice profile:
  - Name: Asha Rao
  - Email: asha@example.com
  - Phone: +91 90000 00000
  - College: Demo Institute of Technology
  - Degree: B.Tech · Graduation year: 2027
  - Skills: JavaScript, Python, SQL
- **Keys:** only ever show a saved key in its masked form (`AIzaSy…abcd`), never the key box while typing.
- **Pages:** use public articles that anyone can open, the practice site, and for the blocked shot, a bank's public login page. Don't log in anywhere. No real email inbox: for the Gmail-style shots use your own test message, or skip them.
- **Format:** PNG, captured at 2× (Retina) if possible, cropped to the side panel plus enough of the page to give context. Aim for under 400 KB each, and run them through a lossless optimiser (for example ImageOptim or `oxipng`).
- Before committing, look at every image at full size for names, emails, tabs and notifications you didn't mean to include.

## Shot list

| File | Where | What to show |
|---|---|---|
| `read-summary-en.png` | Read tab on a news or Wikipedia article | The summary card in English: TL;DR, the five key points and next steps, with the "via Gemini" chip. |
| `read-summary-hinglish.png` | Same page | The same card after switching the header to **Hinglish**. |
| `chat-not-found.png` | Chat tab on the same article | Two or three questions answered from the page, then one the page doesn't cover, with the "not found on this page" answer. |
| `context-menu-draft.png` | Chat tab, after right-click → **Pagewise → Draft a reply** on a short message | The draft with its **Shorter**, **More formal** and **Reply as** chips. If you can, show the right-click menu open on the page beside it. |
| `see-crop.png` | See tab on a page with a chart | The captured screen with a crop box drawn around the chart, and the question and answer below. |
| `agent-badges.png` | Agent tab on the practice internship form | **Show numbers** on, so the numbered badges are visible on the page, with the action map open in the panel. |
| `agent-confirm.png` | Agent tab, internship form step 3 | The approval card for **Submit application**, after pressing Approve, showing the second confirmation. Use a goal with "Use my profile" on, so earlier steps in the log show values "from your profile". |
| `agent-log.png` | Settings → Agent logs | A finished task's timeline: approved, skipped and blocked steps, with **Export JSON** and **Export Markdown** visible. |
| `safety-blocked.png` | Any page in Pagewise's bank list, such as a bank's public net-banking login page, without logging in | The 🔴 badge in the header and the Read tab's "switched off on payment and banking pages" message. |
| `skills-list.png` | Skills tab | The four starter skills plus one of your own, such as "Make flashcards from this page". |

## Demo GIF (`docs/demo.gif`)

About 20–30 seconds, under 5 MB, 800 px wide or less, at 10–12 frames per second. A screen recorder that exports GIF works (for example Kap on macOS or ScreenToGif on Windows).

1. Open an article and click **Summarise this page** (cut the wait for the answer).
2. Flip to **Hinglish**.
3. Switch to the practice internship form, type a goal in the Agent tab, and **Approve** two steps so you can see the fields fill.
4. Press **Stop**.

## After capturing

1. Check the images against the list above.
2. Commit them. The README picks them up straight away.
3. The Pages workflow republishes the landing page with the screenshots on the next push to `main`.
