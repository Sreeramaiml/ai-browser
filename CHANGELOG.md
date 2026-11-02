# Changelog

All notable changes to Sahayak are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

Each release's notes on GitHub are copied from its section below. Before tagging, rename **Unreleased** to the new version and date, for example `## [1.0.0] - 2026-11-28`.

## [Unreleased]

### Added

- **Read:** summarise an article or a public YouTube video (with chapter timestamps), and explain selected text. Answers in English or Hinglish, switched from the panel header.
- **Chat with the page:** answers come only from the page you're on, streamed as they're written, and say so when the page doesn't have the answer.
- **Right-click actions** on selected text: Explain, Translate, and Draft a reply (with Shorter and More formal follow-ups).
- **See:** capture the visible screen, crop it, and ask about it.
- **Find it for me:** points at the button or field you describe, without clicking anything.
- **Agent:** does a task one step at a time, and nothing happens until you approve each step. Includes Skip, Stop (also `Esc` and `Alt+Shift+X`), a step limit, dry run, a second confirmation for submit, send and delete, and a reviewable log you can export as JSON or Markdown. Runs only on the practice site and on sites you add as your own.
- **Profile:** your details, kept only on this device, to fill forms (every value is shown before it's typed) and to sign drafted replies.
- **Skills:** one-click prompt recipes, with four starters, that can be exported to and imported from a small JSON file.
- **Safety:** Sahayak switches off on banking and payment pages, reads private pages (email, documents, messages) only as text you select, never types passwords, OTPs or card numbers, and never pays or logs in for you. Card numbers, Aadhaar, PAN, OTPs, UPI IDs and API keys are removed before anything is sent to the AI. A 🟢 / 🟡 / 🔴 badge shows how Sahayak treats the current page.
- **Free-tier friendly:** Gemini by default, with an optional free Groq key as a text-only backup when Gemini is busy.
- **Practice site** for trying the agent safely: an internship form, a shop, a club directory, and pages with login, OTP, card and UPI forms.
- **Clear all my data** in Settings removes the profile, skills, logs, chat history and keys.
