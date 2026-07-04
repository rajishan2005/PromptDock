/* ===========================================================
   PromptDock — content script
   Injects a docked panel into ChatGPT that lets you:
     1) Load a PDF question bank
     2) Crop any region of a page straight into the chat box (as an image)
     3) Auto-detect numbered questions and insert them as text
   =========================================================== */

(function () {
  if (window.__promptDockInjected) return;
  window.__promptDockInjected = true;

  // ---- pdf.js setup -----------------------------------------------------
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("libs/pdf.worker.min.js");
  }

  // ---- state --------------------------------------------------------------
  const state = {
    pdfDoc: null,
    fileName: "",
    fileSize: 0,
    pageNum: 1,
    numPages: 0,
    scale: 1.4,
    renderTask: null,
    selection: null, // {x,y,w,h} in css px, relative to canvas
    cropBlob: null,
    questions: [], // {number, text, page}
    scanning: false,
    activeTab: "pdf",
  };

  // ---- helpers to find the ChatGPT composer -------------------------------
  function getEditor() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector("form textarea") ||
      document.querySelector("textarea")
    );
  }

  function showToast(msg) {
    let t = document.getElementById("pd-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "pd-toast";
      t.className = "pd-toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("pd-show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.classList.remove("pd-show"), 2200);
  }

  function insertImageToChat(blob) {
    const editor = getEditor();
    if (!editor) {
      showToast("Couldn't find the ChatGPT chat box — click into it once, then retry.");
      return;
    }
    const file = new File([blob], `promptdock-crop-${Date.now()}.png`, { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);

    editor.focus();

    // Primary path: emulate a paste, which ChatGPT's composer already handles for images.
    try {
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      editor.dispatchEvent(pasteEvent);
    } catch (e) {
      /* constructor not supported in this context — fall through to drop */
    }

    // Fallback path: emulate a drag-and-drop, which ChatGPT also supports for uploads.
    const dropTarget = editor.closest("form") || editor.parentElement || document.body;
    ["dragenter", "dragover", "drop"].forEach((type) => {
      try {
        const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
        dropTarget.dispatchEvent(evt);
      } catch (e) {
        /* ignore unsupported */
      }
    });

    showToast("Crop sent to ChatGPT ✓");
  }

  function insertTextToChat(text) {
    const editor = getEditor();
    if (!editor) {
      showToast("Couldn't find the ChatGPT chat box — click into it once, then retry.");
      return;
    }
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(editor, (editor.value ? editor.value + "\n" : "") + text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("insertText", false, text);
    }
    showToast("Question inserted ✓");
  }

  // ---- build the panel DOM -------------------------------------------------
  const fab = document.createElement("button");
  fab.id = "pd-fab";
  fab.textContent = "PromptDock";
  document.body.appendChild(fab);

  const root = document.createElement("div");
  root.id = "pd-root";
  root.className = "pd-hidden";
  root.innerHTML = `
    <div class="pd-header">
      <div class="pd-logo">P</div>
      <h1>PromptDock</h1>
      <button class="pd-close" id="pd-close" title="Close">✕</button>
    </div>
    <div class="pd-tabs">
      <button class="pd-tab active" data-tab="pdf">PDF &amp; Crop</button>
      <button class="pd-tab" data-tab="questions">Questions</button>
    </div>
    <div class="pd-body" id="pd-body"></div>
  `;
  document.body.appendChild(root);

  const bodyEl = root.querySelector("#pd-body");

  // ---- templates ------------------------------------------------------------
  function renderPdfTab() {
    if (!state.pdfDoc) {
      bodyEl.innerHTML = `
        <div class="pd-card">
          <div class="pd-card-title">Question bank</div>
          <div class="pd-dropzone" id="pd-dropzone">
            <svg viewBox="0 0 24 24" fill="none" stroke="#b18cff" stroke-width="1.6"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>
            Click to upload, or drop a PDF here
          </div>
          <input type="file" id="pd-file-input" accept="application/pdf" style="display:none" />
        </div>
        <div class="pd-hint">Load your question bank PDF once — then crop any question directly into the chat, or switch to <b>Questions</b> to extract them as text.</div>
      `;
      bodyEl.querySelector("#pd-dropzone").addEventListener("click", () => bodyEl.querySelector("#pd-file-input").click());
      bodyEl.querySelector("#pd-file-input").addEventListener("change", (e) => {
        if (e.target.files[0]) loadPdf(e.target.files[0]);
      });
      const dz = bodyEl.querySelector("#pd-dropzone");
      dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("pd-drag"); });
      dz.addEventListener("dragleave", () => dz.classList.remove("pd-drag"));
      dz.addEventListener("drop", (e) => {
        e.preventDefault();
        dz.classList.remove("pd-drag");
        const f = e.dataTransfer.files[0];
        if (f && f.type === "application/pdf") loadPdf(f);
      });
      return;
    }

    bodyEl.innerHTML = `
      <div class="pd-card">
        <div class="pd-file-row">
          <div class="pd-file-icon">📄</div>
          <div class="pd-file-meta">
            <div class="pd-file-name">${state.fileName}</div>
            <div class="pd-file-sub">${state.numPages} page${state.numPages > 1 ? "s" : ""} · ${(state.fileSize / (1024 * 1024)).toFixed(1)} MB</div>
          </div>
          <button class="pd-icon-btn" id="pd-remove" title="Remove PDF">🗑</button>
        </div>
      </div>

      <div class="pd-card">
        <div class="pd-preview-toolbar">
          <div class="pd-group">
            <button class="pd-mini-btn" id="pd-prev">‹</button>
            <span id="pd-page-label">${state.pageNum} / ${state.numPages}</span>
            <button class="pd-mini-btn" id="pd-next">›</button>
          </div>
          <div class="pd-group">
            <button class="pd-mini-btn" id="pd-zoom-out">−</button>
            <span id="pd-zoom-label">${Math.round(state.scale * 100)}%</span>
            <button class="pd-mini-btn" id="pd-zoom-in">+</button>
          </div>
        </div>
        <div class="pd-canvas-wrap" id="pd-canvas-wrap">
          <canvas id="pd-canvas"></canvas>
          <div id="pd-crop-overlay"></div>
        </div>
        <div class="pd-hint">Drag directly over the question to select it, then hit <b>Insert Crop to Chat</b> below.</div>
      </div>

      <div class="pd-card" id="pd-crop-card" style="display:none">
        <div class="pd-card-title">Cropped selection</div>
        <div class="pd-crop-preview"><img id="pd-crop-img" /></div>
        <div style="height:10px"></div>
        <button class="pd-btn pd-btn-primary" id="pd-insert-crop">🖼️ Insert Crop to Chat</button>
        <div style="height:8px"></div>
        <button class="pd-btn pd-btn-secondary" id="pd-clear-crop">Clear selection</button>
      </div>
    `;

    bodyEl.querySelector("#pd-remove").addEventListener("click", resetPdf);
    bodyEl.querySelector("#pd-prev").addEventListener("click", () => changePage(-1));
    bodyEl.querySelector("#pd-next").addEventListener("click", () => changePage(1));
    bodyEl.querySelector("#pd-zoom-in").addEventListener("click", () => changeZoom(0.2));
    bodyEl.querySelector("#pd-zoom-out").addEventListener("click", () => changeZoom(-0.2));

    renderPage();
    setupCropOverlay();

    if (state.cropBlob) showCropPreview();
  }

  function renderQuestionsTab() {
    if (!state.pdfDoc) {
      bodyEl.innerHTML = `<div class="pd-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="#8a8a99" stroke-width="1.5"><path d="M9 12h6M9 16h6M9 8h6M5 21V5a2 2 0 012-2h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2z"/></svg>
        Load a PDF in the <b>PDF &amp; Crop</b> tab first.
      </div>`;
      return;
    }

    const listHtml = state.questions.length
      ? state.questions
          .map(
            (q, i) => `
        <div class="pd-question-item">
          <span class="pd-q-tag">Q${q.number}${q.unit ? " · " + escapeHtml(q.unit) : ""} · p.${q.page}</span>
          <div class="pd-question-text">${escapeHtml(q.text)}</div>
          <div class="pd-question-actions">
            <button class="pd-btn pd-btn-primary" data-idx="${i}" data-action="send">Send to Chat</button>
            <button class="pd-btn pd-btn-secondary" data-idx="${i}" data-action="copy">Copy</button>
          </div>
        </div>`
          )
          .join("")
      : `<div class="pd-empty">No questions extracted yet.</div>`;

    bodyEl.innerHTML = `
      <div class="pd-card">
        <div class="pd-card-title">Extract questions</div>
        <button class="pd-btn pd-btn-secondary" id="pd-scan-page" ${state.scanning ? "disabled" : ""}>Scan current page (p.${state.pageNum})</button>
        <div style="height:8px"></div>
        <button class="pd-btn pd-btn-ghost" id="pd-scan-all" ${state.scanning ? "disabled" : ""}>Scan entire PDF (${state.numPages} pages)</button>
        ${state.scanning ? `<div style="height:8px"></div><div class="pd-scan-progress" id="pd-scan-progress">Scanning…</div>` : ""}
      </div>
      <div class="pd-card">
        <div class="pd-card-title">Detected questions (${state.questions.length})</div>
        <div class="pd-questions-list">${listHtml}</div>
      </div>
    `;

    bodyEl.querySelector("#pd-scan-page").addEventListener("click", () => scanQuestions(false));
    bodyEl.querySelector("#pd-scan-all").addEventListener("click", () => scanQuestions(true));

    bodyEl.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = state.questions[+btn.dataset.idx];
        if (btn.dataset.action === "send") {
          insertTextToChat(q.text);
        } else {
          navigator.clipboard.writeText(q.text).then(() => showToast("Copied ✓"));
        }
      });
    });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render() {
    if (state.activeTab === "pdf") renderPdfTab();
    else renderQuestionsTab();
  }

  // ---- tab switching ---------------------------------------------------
  root.querySelectorAll(".pd-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      root.querySelectorAll(".pd-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeTab = tab.dataset.tab;
      render();
    });
  });

  root.querySelector("#pd-close").addEventListener("click", () => root.classList.add("pd-hidden"));
  fab.addEventListener("click", () => root.classList.toggle("pd-hidden"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROMPTDOCK_TOGGLE") root.classList.toggle("pd-hidden");
  });

  // ---- PDF loading & rendering --------------------------------------------
  async function loadPdf(file) {
    state.fileName = file.name;
    state.fileSize = file.size;
    const buf = await file.arrayBuffer();
    const loadingTask = window.pdfjsLib.getDocument({ data: buf });
    state.pdfDoc = await loadingTask.promise;
    state.numPages = state.pdfDoc.numPages;
    state.pageNum = 1;
    state.selection = null;
    state.cropBlob = null;
    state.questions = [];
    render();
  }

  function resetPdf() {
    state.pdfDoc = null;
    state.fileName = "";
    state.numPages = 0;
    state.pageNum = 1;
    state.selection = null;
    state.cropBlob = null;
    state.questions = [];
    render();
  }

  function changePage(delta) {
    const next = state.pageNum + delta;
    if (next < 1 || next > state.numPages) return;
    state.pageNum = next;
    state.selection = null;
    state.cropBlob = null;
    render();
  }

  function changeZoom(delta) {
    const next = Math.min(3, Math.max(0.6, +(state.scale + delta).toFixed(2)));
    state.scale = next;
    render();
  }

  async function renderPage() {
    const page = await state.pdfDoc.getPage(state.pageNum);
    const viewport = page.getViewport({ scale: state.scale });
    const dpr = window.devicePixelRatio || 1;

    const canvas = bodyEl.querySelector("#pd-canvas");
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + "px";
    canvas.style.height = viewport.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const overlay = bodyEl.querySelector("#pd-crop-overlay");
    overlay.style.width = viewport.width + "px";
    overlay.style.height = viewport.height + "px";

    if (state.renderTask) {
      try { state.renderTask.cancel(); } catch (e) {}
    }
    state.renderTask = page.render({ canvasContext: ctx, viewport });
    try {
      await state.renderTask.promise;
    } catch (e) {
      /* cancelled render — ignore */
    }
  }

  // ---- crop overlay drag-select -------------------------------------------
  function setupCropOverlay() {
    const overlay = bodyEl.querySelector("#pd-crop-overlay");
    const wrap = bodyEl.querySelector("#pd-canvas-wrap");
    if (!overlay || !wrap) return;

    let dragging = false;
    let startX = 0, startY = 0;
    let selDiv = null;
    let lastClientX = 0, lastClientY = 0;
    let scrollRaf = null;

    const EDGE = 36; // px from the visible edge that triggers auto-scroll
    const SPEED = 14; // px scrolled per frame at max proximity

    function updateSelectionFromClient(clientX, clientY) {
      const rect = overlay.getBoundingClientRect();
      const curX = clientX - rect.left;
      const curY = clientY - rect.top;
      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);
      selDiv.style.left = x + "px";
      selDiv.style.top = y + "px";
      selDiv.style.width = w + "px";
      selDiv.style.height = h + "px";
      state.selection = { x, y, w, h };
    }

    function autoScrollTick() {
      if (!dragging) { scrollRaf = null; return; }
      const wrapRect = wrap.getBoundingClientRect();
      let dx = 0, dy = 0;

      if (lastClientX < wrapRect.left + EDGE) dx = -SPEED * ((wrapRect.left + EDGE - lastClientX) / EDGE);
      else if (lastClientX > wrapRect.right - EDGE) dx = SPEED * ((lastClientX - (wrapRect.right - EDGE)) / EDGE);

      if (lastClientY < wrapRect.top + EDGE) dy = -SPEED * ((wrapRect.top + EDGE - lastClientY) / EDGE);
      else if (lastClientY > wrapRect.bottom - EDGE) dy = SPEED * ((lastClientY - (wrapRect.bottom - EDGE)) / EDGE);

      if (dx !== 0 || dy !== 0) {
        wrap.scrollLeft += dx;
        wrap.scrollTop += dy;
        updateSelectionFromClient(lastClientX, lastClientY);
      }
      scrollRaf = requestAnimationFrame(autoScrollTick);
    }

    overlay.addEventListener("mousedown", (e) => {
      const rect = overlay.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      dragging = true;
      if (selDiv) selDiv.remove();
      selDiv = document.createElement("div");
      selDiv.className = "pd-selection";
      overlay.appendChild(selDiv);
      if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScrollTick);
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging || !selDiv) return;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      updateSelectionFromClient(e.clientX, e.clientY);
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      if (state.selection && state.selection.w > 8 && state.selection.h > 8) {
        cropSelectionToBlob();
      }
    });
  }

  const HQ_SCALE = 4; // fixed high-quality render scale, independent of current on-screen zoom

  async function getHqPageCanvas(pageNum) {
    if (state.hqCache && state.hqCache.pageNum === pageNum) return state.hqCache.canvas;
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: HQ_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    state.hqCache = { pageNum, canvas };
    return canvas;
  }

  async function cropSelectionToBlob() {
    const canvas = bodyEl.querySelector("#pd-canvas");
    if (!canvas || !state.selection) return;
    const { x, y, w, h } = state.selection;

    // Selection was made against the on-screen canvas (at state.scale) — convert
    // to a 0..1 fraction of the page, then sample from a high-res render so the
    // crop stays crisp no matter how zoomed out the preview currently is.
    const dispW = canvas.clientWidth;
    const dispH = canvas.clientHeight;
    const fx = x / dispW, fy = y / dispH, fw = w / dispW, fh = h / dispH;

    let hqCanvas;
    try {
      hqCanvas = await getHqPageCanvas(state.pageNum);
    } catch (e) {
      showToast("Couldn't render a high-quality crop — try again.");
      return;
    }

    const sx = fx * hqCanvas.width;
    const sy = fy * hqCanvas.height;
    const sw = fw * hqCanvas.width;
    const sh = fh * hqCanvas.height;

    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw));
    out.height = Math.max(1, Math.round(sh));
    out.getContext("2d").drawImage(hqCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

    out.toBlob((blob) => {
      state.cropBlob = blob;
      showCropPreview();
    }, "image/png");
  }

  function showCropPreview() {
    const card = bodyEl.querySelector("#pd-crop-card");
    const img = bodyEl.querySelector("#pd-crop-img");
    if (!card || !img || !state.cropBlob) return;
    img.src = URL.createObjectURL(state.cropBlob);
    card.style.display = "block";

    bodyEl.querySelector("#pd-insert-crop").onclick = () => insertImageToChat(state.cropBlob);
    bodyEl.querySelector("#pd-clear-crop").onclick = () => {
      state.selection = null;
      state.cropBlob = null;
      card.style.display = "none";
      const overlay = bodyEl.querySelector("#pd-crop-overlay");
      overlay.querySelectorAll(".pd-selection").forEach((el) => el.remove());
    };
  }

  // ---- question extraction -------------------------------------------------
  // Matches "1. text", "1) text", "Q1. text", and bare table-style "1  text"
  // (a number in its own column, no punctuation, followed by whitespace + a
  // capital letter so we don't accidentally match numbers inside sentences).
  const Q_START = /^(?:Q\.?\s*)?(\d{1,3})[\.\)]?\s+(?=[A-Z(])/;

  async function getPageLines(pageIndex) {
    const page = await state.pdfDoc.getPage(pageIndex);
    const content = await page.getTextContent();
    const lines = {};
    content.items.forEach((item) => {
      const y = Math.round(item.transform[5]);
      if (!lines[y]) lines[y] = [];
      lines[y].push(item.str);
    });
    const ys = Object.keys(lines).map(Number).sort((a, b) => b - a);
    return ys.map((y) => lines[y].join(" ").replace(/\s+/g, " ").trim()).filter(Boolean);
  }

  // Runs a single pass over an ordered list of {line, page} entries, tracking
  // the expected next question number so stray numbers inside a question's
  // body text (measurements, options, etc.) don't get mistaken for a new
  // question — a line only starts a new question if it continues the
  // sequence (or is the very first match found).
  // Detects unit/section header lines (e.g. "UNIT-1", "UNIT 5", "Unit-III") so
  // numbering resets there instead of continuing from the previous unit.
  const UNIT_HEADER = /^UNIT[\s\-.]*([IVXLC\d]+)\b/i;

  function extractQuestions(lineEntries) {
    const found = [];
    let current = null;
    let expected = null;
    let unit = null;

    lineEntries.forEach(({ line, page }) => {
      const unitMatch = line.match(UNIT_HEADER);
      if (unitMatch) {
        if (current) { found.push(current); current = null; }
        expected = null;
        unit = line.trim();
        return;
      }

      const m = line.match(Q_START);
      const num = m ? parseInt(m[1], 10) : null;

      if (m && (expected === null || num === expected)) {
        if (current) found.push(current);
        current = { number: num, text: line.slice(m[0].length).trim(), page, unit };
        expected = num + 1;
      } else if (current) {
        current.text += " " + line;
      }
    });

    if (current) found.push(current);
    return found;
  }

  async function scanQuestions(allPages) {
    state.scanning = true;
    render();
    try {
      const lineEntries = [];
      if (allPages) {
        for (let p = 1; p <= state.numPages; p++) {
          const progress = bodyEl.querySelector("#pd-scan-progress");
          if (progress) progress.textContent = `Scanning page ${p} of ${state.numPages}…`;
          const lines = await getPageLines(p);
          lines.forEach((line) => lineEntries.push({ line, page: p }));
        }
      } else {
        const lines = await getPageLines(state.pageNum);
        lines.forEach((line) => lineEntries.push({ line, page: state.pageNum }));
      }
      state.questions = extractQuestions(lineEntries);
      if (state.questions.length === 0) {
        showToast("No numbered questions detected on this page.");
      }
    } catch (e) {
      console.error("[PromptDock] scan failed:", e);
      showToast("Scan failed — check the console for details.");
    }
    state.scanning = false;
    render();
  }

  // done — panel is ready but hidden until the toolbar icon or FAB is clicked.
})();
