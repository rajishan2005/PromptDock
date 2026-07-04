# PromptDock — PDF Crop & Extract for ChatGPT

A Chrome/Brave extension that docks a clean panel onto chatgpt.com so you can:

1. **Load a PDF** question bank once.
2. **Crop** any question directly from the PDF preview and send it into the ChatGPT chat box as an image — no screenshot tool needed.
3. **Extract questions** — auto-detects numbered questions (`1.`, `2)`, `Q1.` etc.) from the PDF text and lets you send any one straight into the chat as text with one click.

## Install (unpacked, ~30 seconds)

1. Unzip this folder somewhere permanent (don't delete it after installing — Chrome loads the extension from these files).
2. Open `chrome://extensions` (or `brave://extensions`).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `promptdock` folder.
5. Open `https://chatgpt.com`. You'll see a small **PromptDock** tab docked to the right edge of the screen — click it (or click the extension's toolbar icon) to open the panel.

## How to use

- **PDF & Crop tab:** upload/drop your PDF, use the ‹ › and −/+ controls to navigate and zoom, then **drag directly over a question** in the preview to select it. A "Cropped selection" card appears below — hit **Insert Crop to Chat** to drop it straight into the ChatGPT input as an image, ready to send.
- **Questions tab:** hit **Scan current page** for a quick pass, or **Scan entire PDF** to index everything. Each detected question shows with a **Send to Chat** button (inserts as text) or **Copy**.

## Notes / limitations

- Works on `chatgpt.com` and `chat.openai.com`.
- Image insertion emulates ChatGPT's native paste/drop handling. If OpenAI changes their composer's DOM/structure, the insert may need a small selector tweak in `content.js` (see `getEditor()`).
- Question detection uses a simple numbered-line pattern (`1.`, `2)`, `Q1.`) — great for typical question-bank PDFs; oddly formatted PDFs (multi-column, scanned/image-only pages) may need manual cropping instead.
- Everything runs 100% locally in your browser — the PDF never leaves your machine, and no data is sent anywhere except what you deliberately insert into the chat.

## Files

```
promptdock/
├── manifest.json         Extension config (Manifest V3)
├── background.js         Toggles the panel from the toolbar icon
├── content.js            Panel UI, PDF rendering, crop tool, chat injection
├── panel.css             Styling
├── libs/                 Bundled pdf.js (rendering + text extraction)
└── icons/                Toolbar icons
```
