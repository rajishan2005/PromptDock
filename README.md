# PromptDock — PDF Crop, Extract & Autosolve for ChatGPT

A Chrome/Brave extension that docks a clean panel onto chatgpt.com so you can:

1. **Load a PDF** question bank once — it's automatically saved to your local **PDF library** (📚 button in the header) so you can reopen it instantly next time, no re-uploading.
2. **Crop** any question directly from the PDF preview and send it into the ChatGPT chat box as an image — no screenshot tool needed. Works at any zoom level (crops are always rendered at high resolution), and auto-scrolls as you drag near an edge so you can select something bigger than the visible area.
3. **Extract questions** — auto-detects numbered questions (`1.`, `2)`, `Q1.`, or bare table-style numbering) from the PDF text, resets numbering at each `UNIT` header, and lets you send any one straight into the chat as text with one click.
4. **Autosolve** — click the "Autosolve" header to reveal the PDF-context toggle and optional instructions, then Start sends every detected question to ChatGPT one after another: types it in, submits it, waits for ChatGPT to finish answering, cools down 3 seconds, then moves to the next. While running, a live progress bar shows which question it's on; if one fails to send or a reply can't be detected, it's skipped and the run continues rather than stopping. Shows the total time taken once the whole run finishes.
   - **Answer based on this PDF** toggle (on by default) — before the questions start, uploads the actual PDF into the chat with an instruction to answer only from it, so replies are grounded in your material instead of ChatGPT's general knowledge.
   - **Custom instructions box** (optional) — anything typed here (e.g. "only key points", "keep it a summary") is appended to that same priming message.
5. **Question bank store** (🏪 button in the header) — browse a shared library of question-bank PDFs organized by stream → semester → subject, hosted in a public GitHub repo, and load any of them straight into PromptDock with one click.
6. **Saved chat links** (🔗 button in the header) — save the current ChatGPT conversation's URL, tagged to whichever PDF + page you were on, so you can jump straight back to a module and its answers later.
7. **Pixel cat study buddy** (🐱 button in the header) — a small 8-bit cat that hops out and sits near your chat box. Click it to set a focus timer on a scroll-wheel MM:SS picker; it naps for that long, then wakes up hungry — click it again to feed it. Quiet by design: minimal motion while idle/asleep, no popups or sounds.

## Install (unpacked, ~30 seconds)

1. Unzip this folder somewhere permanent (don't delete it after installing — Chrome loads the extension from these files).
2. Open `chrome://extensions` (or `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `promptdock` folder.
5. Open `https://chatgpt.com`. You'll see a small **PromptDock** tab docked to the right edge of the screen — click it (or click the extension's toolbar icon) to open the panel.

## How to use

- **PDF & Crop tab:** upload/drop your PDF (or reopen one from 📚 **PDF library**), use the ‹ › and −/+ controls to navigate and zoom, then **drag directly over a question** in the preview to select it. Drag near an edge while zoomed in and it'll auto-pan for you. A "Cropped selection" card appears below — hit **Insert Crop to Chat** to drop it straight into the ChatGPT input as an image, ready to send.
- **Questions tab:** hit **Scan current page** for a quick pass, or **Scan entire PDF** to index everything. Each detected question shows with a **Send to Chat** button (inserts as text) or **Copy**. Use **Start Autosolve** to have it work through the whole list unattended — **Stop Autosolve** cancels it at any point, taking effect within about a second even mid-wait.
- **📚 PDF library (header button):** every PDF you upload is saved here automatically (full file, stored locally) so you can reopen it without hunting for the file again. Delete any entry you don't want kept.
- **🏪 Question bank store (header button):** browse by stream → semester → subject. Each file has two actions: 📂 loads it straight into PromptDock, ⬇ saves the actual PDF to your device. This reads a public GitHub repo live — see "Setting up the question bank store" below if you're maintaining that repo.
- **🔗 Saved chats (header button):** save the current tab's ChatGPT link, tagged to the PDF/page you were working from. Click any saved entry to reopen that conversation in a new tab.

## Setting up the question bank store (maintainer note)

The store browses a **public GitHub repo** live via GitHub's API — no server, no database, just folders of PDFs.

1. Create a public repo (e.g. `promptdock-qbanks`).
2. Organize it as `Stream/Semester/Subject/file.pdf`, for example:
   ```
   ISE/Sem3/Digital-Electronics/qbank.pdf
   CSE/Sem4/DBMS/qbank.pdf
   ```
3. In `content.js`, update the `QBANK_REPO` constant near the top to point at that repo:
   ```js
   const QBANK_REPO = { owner: "your-username", repo: "promptdock-qbanks", branch: "main" };
   ```
4. That's it — adding a new question bank later is just uploading a PDF into the right folder on GitHub's website. No code changes, no redeploy.

## Notes / limitations

- Works on `chatgpt.com` and `chat.openai.com`.
- Image/text insertion and Autosolve's submit/completion-detection emulate ChatGPT's own composer behavior via a handful of DOM selectors. If OpenAI changes their composer's structure, these may need a small selector tweak in `content.js` (see `getEditor()`, `submitMessage()`, and `getStopButton()`).
- Question detection uses a simple numbered-line pattern — great for typical question-bank PDFs; oddly formatted PDFs (multi-column, scanned/image-only pages) may need manual cropping instead.
- The PDF library stores full files locally via the extension's own storage (not synced anywhere) — the `unlimitedStorage` permission is used so larger PDFs aren't capped by the default quota. Delete entries you no longer need to free up space.
- Everything runs 100% locally in your browser — PDFs never leave your machine, and no data is sent anywhere except what you deliberately insert into the chat.

## Files

```
promptdock/
├── manifest.json         Extension config (Manifest V3)
├── background.js         Toggles the panel from the toolbar icon
├── content.js             Panel UI, PDF rendering, crop tool, chat injection, library, autosolve
├── panel.css             Styling
├── libs/                 Bundled pdf.js (rendering + text extraction)
└── icons/                Toolbar icons
```

