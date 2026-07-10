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

  // ---- question bank store config ------------------------------------------
  // TODO: update these once the public question-bank repo exists.
  // Expected folder layout inside that repo: Stream/Semester/Subject/file.pdf
  const QBANK_REPO = { owner: "rajishan2005", repo: "pdqb", branch: "main" };

  // ---- state --------------------------------------------------------------
  const state = {
    pdfDoc: null,
    currentFile: null, // the actual File object, kept so we can attach it to the chat
    fileName: "",
    fileSize: 0,
    pageNum: 1,
    numPages: 0,
    scale: 1.4,
    renderTask: null,
    selection: null, // {x,y,w,h} in css px, relative to canvas
    cropBlob: null,
    questions: [], // {number, text, page, unit}
    scanning: false,
    activeTab: "pdf",
    overlay: null, // null | "library" | "chats" | "store"
    storeNav: { stream: null, sem: null, subject: null },
    storeCache: {},
    autosolve: {
      running: false,
      expanded: false,
      index: 0,
      status: "",
      startedAt: null,
      usePdfContext: true, // ON by default — answers grounded in the uploaded PDF
      customInstructions: "",
    },
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

  function dispatchDragEvent(target, type, dataTransfer = null) {
    try {
      const evt = new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: 0,
        clientY: 0,
      });
      target.dispatchEvent(evt);
    } catch (e) {
      /* ignore unsupported synthetic drag events */
    }
  }

  function clearChatDropOverlay(dropTarget) {
    const targets = [dropTarget, document.body, document.documentElement, document, window].filter(Boolean);
    const clear = () => {
      targets.forEach((target) => {
        dispatchDragEvent(target, "dragleave");
        dispatchDragEvent(target, "dragend");
      });
      try {
        document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", bubbles: true }));
      } catch (e) {
        /* ignore unsupported synthetic keyboard events */
      }
    };

    clear();
    setTimeout(clear, 80);
    setTimeout(clear, 300);
  }

  // Attaches any File (image, PDF, etc.) to the ChatGPT composer by emulating
  // a paste (primary) or a drag-and-drop (fallback) — the same mechanism a
  // real user's clipboard paste or file drop would trigger.
  function attachFileToChat(file, { toastMsg = "Sent to ChatGPT ✓" } = {}) {
    const editor = getEditor();
    if (!editor) {
      showToast("Couldn't find the ChatGPT chat box — click into it once, then retry.");
      return false;
    }
    const dt = new DataTransfer();
    dt.items.add(file);

    editor.focus();

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

    const dropTarget = editor.closest("form") || editor.parentElement || document.body;
    ["dragenter", "dragover", "drop"].forEach((type) => dispatchDragEvent(dropTarget, type, dt));
    clearChatDropOverlay(dropTarget);

    showToast(toastMsg);
    return true;
  }

  function insertImageToChat(blob) {
    const file = new File([blob], `promptdock-crop-${Date.now()}.png`, { type: "image/png" });
    attachFileToChat(file, { toastMsg: "Crop sent to ChatGPT ✓" });
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
      <button class="pd-icon-btn" id="pd-lib-btn" title="PDF library">📚</button>
      <button class="pd-icon-btn" id="pd-chats-btn" title="Saved chat links">🔗</button>
      <button class="pd-icon-btn" id="pd-store-btn" title="Question bank store">🏪</button>
      <button class="pd-close" id="pd-close" title="Close">✕</button>
    </div>
    <div class="pd-tabs">
      <button class="pd-tab active" data-tab="pdf">PDF &amp; Crop</button>
      <button class="pd-tab" data-tab="questions">Questions</button>
    </div>
    <div class="pd-body" id="pd-body"></div>
    <div class="pd-footer">
      For the students, by a student — <a href="https://www.instagram.com/ifo.ish" target="_blank" rel="noopener noreferrer">Ishan</a>
    </div>
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
      bodyEl.innerHTML = `
        <div class="pd-card">
          <div class="pd-card-title">Extract questions</div>
          <button class="pd-btn pd-btn-secondary" disabled>Scan current page</button>
          <div style="height:8px"></div>
          <button class="pd-btn pd-btn-ghost" disabled>Scan entire PDF</button>
          <div class="pd-hint">Load a PDF in the PDF &amp; Crop tab to unlock text extraction.</div>
        </div>

        <div class="pd-card pd-autosolve-card pd-autosolve-open">
          <div class="pd-card-title">Autosolve</div>
          <div class="pd-autosolve-details">
            <div class="pd-toggle-row">
              <div>
                <div class="pd-toggle-label">Answer based on this PDF</div>
                <div class="pd-toggle-sublabel">Uploads the PDF first so ChatGPT answers from it, not general knowledge.</div>
              </div>
              <button class="pd-toggle pd-toggle-on" disabled role="switch" aria-checked="true">
                <span class="pd-toggle-knob"></span>
              </button>
            </div>

            <textarea
              class="pd-textarea"
              placeholder="Any other instructions? (optional) - e.g. only key points, keep it a summary"
              disabled
            ></textarea>

            <div style="height:10px"></div>
          </div>
          <button class="pd-btn pd-btn-primary" disabled>Start Autosolve</button>
          <div class="pd-hint">Autosolve will appear here after questions are detected from a loaded PDF.</div>
        </div>

        <div class="pd-card">
          <div class="pd-card-title">Detected questions (0)</div>
          <div class="pd-empty">
            <svg viewBox="0 0 24 24" fill="none" stroke="#8a8a99" stroke-width="1.5"><path d="M9 12h6M9 16h6M9 8h6M5 21V5a2 2 0 012-2h7l5 5v13a2 2 0 01-2 2H7a2 2 0 01-2-2z"/></svg>
            No PDF loaded yet.
          </div>
        </div>
      `;
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

    const autosolveExpanded = state.autosolve.expanded || state.autosolve.running;
    const autosolveTotal = state.questions.length;
    const autosolveCurrent = state.autosolve.running && autosolveTotal
      ? Math.min(state.autosolve.index + 1, autosolveTotal)
      : Math.min(state.autosolve.index, autosolveTotal);
    const autosolveProgress = autosolveTotal
      ? Math.round((autosolveCurrent / autosolveTotal) * 100)
      : 0;
    const autosolveRunningHtml = state.autosolve.running
      ? `
        <div class="pd-autosolve-running pd-autosolve-running-large">
          <div class="pd-autosolve-running-row">
            <span>Autosolve is solving text</span>
            <span class="pd-bouncing-dots" aria-hidden="true"><i></i><i></i><i></i></span>
          </div>
          <div class="pd-progress-meta">
            <span id="pd-autosolve-progress-label">Question ${autosolveCurrent} of ${autosolveTotal}</span>
            <span id="pd-autosolve-progress-percent">${autosolveProgress}%</span>
          </div>
          <div class="pd-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${autosolveTotal}" aria-valuenow="${autosolveCurrent}">
            <div class="pd-progress-fill" id="pd-autosolve-progress-fill" style="width:${autosolveProgress}%"></div>
          </div>
        </div>`
      : "";
    const autosolveDetailsHtml = autosolveExpanded && !state.autosolve.running
      ? `
        <div class="pd-autosolve-details">
          <div class="pd-toggle-row">
            <div>
              <div class="pd-toggle-label">Answer based on this PDF</div>
              <div class="pd-toggle-sublabel">Uploads the PDF first so ChatGPT answers from it, not general knowledge.</div>
            </div>
            <button class="pd-toggle ${state.autosolve.usePdfContext ? "pd-toggle-on" : "pd-toggle-off"}" id="pd-toggle-context" ${state.autosolve.running ? "disabled" : ""} role="switch" aria-checked="${state.autosolve.usePdfContext}">
              <span class="pd-toggle-knob"></span>
            </button>
          </div>

          <textarea
            class="pd-textarea"
            id="pd-custom-instructions"
            placeholder="Any other instructions? (optional) - e.g. only key points, keep it a summary"
            ${state.autosolve.running ? "disabled" : ""}
          >${escapeHtml(state.autosolve.customInstructions)}</textarea>

          <div style="height:10px"></div>
        </div>`
      : "";

    bodyEl.innerHTML = `
      <div class="pd-card">
        <div class="pd-card-title">Extract questions</div>
        <button class="pd-btn pd-btn-secondary" id="pd-scan-page" ${state.scanning || state.autosolve.running ? "disabled" : ""}>Scan current page (p.${state.pageNum})</button>
        <div style="height:8px"></div>
        <button class="pd-btn pd-btn-ghost" id="pd-scan-all" ${state.scanning || state.autosolve.running ? "disabled" : ""}>Scan entire PDF (${state.numPages} pages)</button>
        ${state.scanning ? `<div style="height:8px"></div><div class="pd-scan-progress" id="pd-scan-progress">Scanning…</div>` : ""}
      </div>
      <div class="pd-card pd-autosolve-card ${autosolveExpanded ? "pd-autosolve-open" : ""}">
        <button class="pd-card-title pd-autosolve-title" id="pd-autosolve-reveal" aria-expanded="${autosolveExpanded}">
          <span>Autosolve</span>
          <span class="pd-autosolve-caret">${autosolveExpanded ? "Hide" : "Options"}</span>
        </button>
        ${autosolveDetailsHtml}
        ${autosolveRunningHtml}
        <button class="pd-btn ${state.autosolve.running ? "pd-btn-secondary" : "pd-btn-primary"}" id="pd-autosolve-toggle" ${state.questions.length === 0 ? "disabled" : ""}>
          ${state.autosolve.running ? "Stop Autosolve" : autosolveExpanded ? "Start Autosolve" : "Autosolve"}
        </button>
        ${autosolveExpanded ? `<div class="pd-hint" id="pd-autosolve-status">${state.autosolve.status || "Sends each detected question one by one, waits for ChatGPT to finish answering, then a 3s cooldown before the next."}</div>` : ""}
      </div>
      <div class="pd-card">
        <div class="pd-card-title">Detected questions (${state.questions.length})</div>
        <div class="pd-questions-list">${listHtml}</div>
      </div>
    `;

    bodyEl.querySelector("#pd-scan-page").addEventListener("click", () => scanQuestions(false));
    bodyEl.querySelector("#pd-scan-all").addEventListener("click", () => scanQuestions(true));
    bodyEl.querySelector("#pd-autosolve-reveal").addEventListener("click", () => {
      if (state.autosolve.running) return;
      state.autosolve.expanded = !state.autosolve.expanded;
      render();
    });
    bodyEl.querySelector("#pd-toggle-context")?.addEventListener("click", () => {
      state.autosolve.usePdfContext = !state.autosolve.usePdfContext;
      render();
    });
    bodyEl.querySelector("#pd-custom-instructions")?.addEventListener("input", (e) => {
      state.autosolve.customInstructions = e.target.value;
    });
    bodyEl.querySelector("#pd-autosolve-toggle").addEventListener("click", () => {
      if (state.autosolve.running) {
        stopAutosolve();
      } else if (!state.autosolve.expanded) {
        state.autosolve.expanded = true;
        render();
      } else {
        startAutosolve();
      }
    });

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

  // ---- PDF library (chrome.storage.local) ----------------------------------
  async function saveToLibrary({ name, size, numPages, dataUrl }) {
    const id = `${Date.now()}`;
    const key = `pdfLib:${id}`;
    const { pdfLibIndex = [] } = await chrome.storage.local.get("pdfLibIndex");
    pdfLibIndex.push(id);
    await chrome.storage.local.set({
      [key]: { id, name, size, numPages, dataUrl, addedAt: Date.now() },
      pdfLibIndex,
    });
  }

  async function deleteLibraryEntry(id) {
    const key = `pdfLib:${id}`;
    const { pdfLibIndex = [] } = await chrome.storage.local.get("pdfLibIndex");
    await chrome.storage.local.remove(key);
    await chrome.storage.local.set({ pdfLibIndex: pdfLibIndex.filter((x) => x !== id) });
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function loadPdfFromDataUrl(dataUrl, name) {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const file = new File([blob], name, { type: "application/pdf" });
    await loadPdf(file, { persist: false });
  }

  async function renderLibraryOverlay() {
    bodyEl.innerHTML = `<div class="pd-card"><div class="pd-card-title">Loading library…</div></div>`;
    let entries = [];
    try {
      const { pdfLibIndex = [] } = await chrome.storage.local.get("pdfLibIndex");
      const keys = pdfLibIndex.map((id) => `pdfLib:${id}`);
      const res = keys.length ? await chrome.storage.local.get(keys) : {};
      entries = pdfLibIndex.map((id) => res[`pdfLib:${id}`]).filter(Boolean).reverse();
    } catch (e) {
      console.error("[PromptDock] library load failed:", e);
    }

    const listHtml = entries.length
      ? entries
          .map(
            (e) => `
        <div class="pd-file-row" style="margin-bottom:8px">
          <div class="pd-file-icon">📄</div>
          <div class="pd-file-meta">
            <div class="pd-file-name">${escapeHtml(e.name)}</div>
            <div class="pd-file-sub">${e.numPages ? e.numPages + " pages · " : ""}${(e.size / (1024 * 1024)).toFixed(1)} MB · ${new Date(e.addedAt).toLocaleDateString()}</div>
          </div>
          <button class="pd-icon-btn" data-open="${e.id}" title="Open" style="color:#b18cff">📂</button>
          <button class="pd-icon-btn" data-del="${e.id}" title="Delete">🗑</button>
        </div>`
          )
          .join("")
      : `<div class="pd-empty">No PDFs saved yet — anything you upload gets added here automatically.</div>`;

    bodyEl.innerHTML = `
      <div class="pd-hint" style="margin:0 0 4px 0">← click a tab above to go back</div>
      <div class="pd-card">
        <div class="pd-card-title">Your PDF library (${entries.length})</div>
        ${listHtml}
      </div>
    `;

    bodyEl.querySelectorAll("[data-open]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.open;
        const key = `pdfLib:${id}`;
        const res = await chrome.storage.local.get(key);
        const entry = res[key];
        if (!entry) { showToast("Could not find that file."); return; }
        btn.textContent = "…";
        try {
          await loadPdfFromDataUrl(entry.dataUrl, entry.name);
          state.overlay = null;
          state.activeTab = "pdf";
          syncTabButtons();
          render();
        } catch (e) {
          console.error("[PromptDock] failed to open library PDF:", e);
          showToast("Couldn't open that PDF.");
        }
      });
    });
    bodyEl.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await deleteLibraryEntry(btn.dataset.del);
        renderLibraryOverlay();
      });
    });
  }

  // ---- saved chat links -----------------------------------------------------
  async function saveCurrentChatLink() {
    const { chatLinks = [] } = await chrome.storage.local.get("chatLinks");
    chatLinks.push({
      id: `${Date.now()}`,
      url: window.location.href,
      pdfName: state.fileName || null,
      page: state.pdfDoc ? state.pageNum : null,
      savedAt: Date.now(),
    });
    await chrome.storage.local.set({ chatLinks });
    showToast("Chat link saved ✓");
    renderChatsOverlay();
  }

  async function renderChatsOverlay() {
    bodyEl.innerHTML = `<div class="pd-card"><div class="pd-card-title">Loading…</div></div>`;
    const { chatLinks = [] } = await chrome.storage.local.get("chatLinks");
    const ordered = chatLinks.slice().reverse();

    const listHtml = ordered.length
      ? ordered
          .map(
            (c) => `
        <div class="pd-file-row" style="margin-bottom:8px; align-items:flex-start">
          <div class="pd-file-icon">🔗</div>
          <div class="pd-file-meta">
            <div class="pd-file-name">${escapeHtml(c.pdfName || "Untitled")}${c.page ? " · p." + c.page : ""}</div>
            <div class="pd-file-sub">${new Date(c.savedAt).toLocaleString()}</div>
          </div>
          <button class="pd-icon-btn" data-open-chat="${c.id}" title="Open chat" style="color:#b18cff">↗</button>
          <button class="pd-icon-btn" data-del-chat="${c.id}" title="Delete">🗑</button>
        </div>`
          )
          .join("")
      : `<div class="pd-empty">No saved chats yet.</div>`;

    bodyEl.innerHTML = `
      <div class="pd-hint" style="margin:0 0 4px 0">← click a tab above to go back</div>
      <div class="pd-card">
        <div class="pd-card-title">Save this chat</div>
        <button class="pd-btn pd-btn-primary" id="pd-save-current-chat">🔗 Save current chat link</button>
        <div class="pd-hint">Saves this tab's link, tagged to ${state.fileName ? "<b>" + escapeHtml(state.fileName) + "</b>" : "the currently loaded PDF"}${state.pdfDoc ? " (page " + state.pageNum + ")" : ""}, so you can jump straight back to the module + its answers later.</div>
      </div>
      <div class="pd-card">
        <div class="pd-card-title">Saved chats (${ordered.length})</div>
        ${listHtml}
      </div>
    `;

    bodyEl.querySelector("#pd-save-current-chat").addEventListener("click", saveCurrentChatLink);
    bodyEl.querySelectorAll("[data-open-chat]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = ordered.find((c) => c.id === btn.dataset.openChat);
        if (entry) window.open(entry.url, "_blank");
      });
    });
    bodyEl.querySelectorAll("[data-del-chat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const { chatLinks: current = [] } = await chrome.storage.local.get("chatLinks");
        const next = current.filter((c) => c.id !== btn.dataset.delChat);
        await chrome.storage.local.set({ chatLinks: next });
        renderChatsOverlay();
      });
    });
  }

  // ---- question bank store (browses a public GitHub repo of PDFs) ----------
  async function fetchQbankDir(path) {
    const cacheKey = path || "__root__";
    if (state.storeCache[cacheKey]) return state.storeCache[cacheKey];
    const url = `https://api.github.com/repos/${QBANK_REPO.owner}/${QBANK_REPO.repo}/contents/${path}?ref=${QBANK_REPO.branch}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 404) throw new Error("Store repo/folder not found — check QBANK_REPO in content.js.");
      if (res.status === 403) throw new Error("Rate-limited by GitHub — try again shortly.");
      throw new Error(`GitHub API error (${res.status})`);
    }
    const data = await res.json();
    state.storeCache[cacheKey] = data;
    return data;
  }

  function getQbankDownloadUrl(fileEntry) {
    return (
      fileEntry.download_url ||
      `https://raw.githubusercontent.com/${QBANK_REPO.owner}/${QBANK_REPO.repo}/${QBANK_REPO.branch}/${fileEntry.path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`
    );
  }

  async function downloadAndLoadQbank(fileEntry) {
    showToast(`Downloading ${fileEntry.name}…`);
    try {
      const res = await fetch(getQbankDownloadUrl(fileEntry));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], fileEntry.name, { type: "application/pdf" });
      await loadPdf(file, { persist: true });
      state.overlay = null;
      state.activeTab = "pdf";
      syncTabButtons();
      render();
      showToast(`${fileEntry.name} loaded ✓`);
    } catch (e) {
      console.error("[PromptDock] qbank download failed:", e);
      showToast("Couldn't download that file.");
    }
  }

  // Saves the file straight to the user's device (a real download), separate
  // from "load into PromptDock" — some people just want the PDF itself.
  async function saveQbankToDevice(fileEntry) {
    showToast(`Saving ${fileEntry.name} to your device…`);
    try {
      const res = await fetch(getQbankDownloadUrl(fileEntry));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileEntry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      showToast(`${fileEntry.name} saved ✓`);
    } catch (e) {
      console.error("[PromptDock] qbank save-to-device failed:", e);
      showToast("Couldn't save that file.");
    }
  }

  async function renderStoreOverlay() {
    bodyEl.innerHTML = `<div class="pd-card"><div class="pd-card-title">Loading store…</div></div>`;

    const nav = state.storeNav;
    const path = [nav.stream, nav.sem, nav.subject].filter(Boolean).join("/");

    let entries;
    try {
      entries = await fetchQbankDir(path);
    } catch (e) {
      bodyEl.innerHTML = `
        <div class="pd-hint" style="margin:0 0 4px 0">← click a tab above to go back</div>
        <div class="pd-card">
          <div class="pd-card-title">Question bank store</div>
          <div class="pd-empty">Store isn't connected yet.<br>${escapeHtml(e.message)}</div>
        </div>
      `;
      return;
    }

    const dirs = entries.filter((e) => e.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.type === "file" && e.name.toLowerCase().endsWith(".pdf"));

    const rootLabel = !nav.stream && files.length && !dirs.length ? "All PDFs" : "All streams";
    const crumbs = [rootLabel, nav.stream, nav.sem, nav.subject].filter(Boolean);
    const breadcrumbHtml = crumbs
      .map(
        (part, i) =>
          `<span data-crumb="${i}" style="cursor:pointer; ${i === crumbs.length - 1 ? "color:#e7e7ee;font-weight:600;" : "color:#b18cff;"}">${escapeHtml(part)}</span>`
      )
      .join(`<span style="color:#55566a"> / </span>`);

    const dirsHtml = dirs
      .map(
        (d) =>
          `<button class="pd-btn pd-btn-secondary" data-dir="${escapeHtml(d.name)}" style="text-align:left; justify-content:flex-start; margin-bottom:6px">📁 ${escapeHtml(d.name)}</button>`
      )
      .join("");

    const filesHtml = files
      .map(
        (f) => `
        <div class="pd-file-row" style="margin-bottom:8px">
          <div class="pd-file-icon">📄</div>
          <div class="pd-file-meta">
            <div class="pd-file-name">${escapeHtml(f.name)}</div>
            <div class="pd-file-sub">${(f.size / (1024 * 1024)).toFixed(1)} MB</div>
          </div>
          <button class="pd-icon-btn" data-download="${escapeHtml(f.path)}" title="Load into PromptDock" style="color:#b18cff">📂</button>
          <button class="pd-icon-btn" data-save="${escapeHtml(f.path)}" title="Save to device" style="color:#b18cff">⬇</button>
        </div>`
      )
      .join("");

    const emptyMsg = !dirs.length && !files.length ? `<div class="pd-empty">Nothing here yet.</div>` : "";

    bodyEl.innerHTML = `
      <div class="pd-hint" style="margin:0 0 4px 0">← click a tab above to go back</div>
      <div class="pd-card">
        <div class="pd-card-title">Question bank store</div>
        <div class="pd-hint" style="margin-bottom:10px">${breadcrumbHtml}</div>
        ${dirsHtml}
        ${emptyMsg}
      </div>
      ${files.length ? `<div class="pd-card"><div class="pd-card-title">Files (${files.length})</div>${filesHtml}</div>` : ""}
    `;

    bodyEl.querySelectorAll("[data-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!nav.stream) nav.stream = btn.dataset.dir;
        else if (!nav.sem) nav.sem = btn.dataset.dir;
        else if (!nav.subject) nav.subject = btn.dataset.dir;
        renderStoreOverlay();
      });
    });

    bodyEl.querySelectorAll("[data-crumb]").forEach((el) => {
      el.addEventListener("click", () => {
        const i = +el.dataset.crumb;
        if (i === 0) { nav.stream = null; nav.sem = null; nav.subject = null; }
        else if (i === 1) { nav.sem = null; nav.subject = null; }
        else if (i === 2) { nav.subject = null; }
        renderStoreOverlay();
      });
    });

    bodyEl.querySelectorAll("[data-download]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = files.find((f) => f.path === btn.dataset.download);
        if (entry) downloadAndLoadQbank(entry);
      });
    });
    bodyEl.querySelectorAll("[data-save]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const entry = files.find((f) => f.path === btn.dataset.save);
        if (entry) saveQbankToDevice(entry);
      });
    });
  }

  function render() {
    if (state.overlay === "library") { renderLibraryOverlay(); return; }
    if (state.overlay === "chats") { renderChatsOverlay(); return; }
    if (state.overlay === "store") { renderStoreOverlay(); return; }
    if (state.activeTab === "pdf") renderPdfTab();
    else renderQuestionsTab();
  }

  function syncTabButtons() {
    root.querySelectorAll(".pd-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === state.activeTab));
  }

  // ---- tab switching ---------------------------------------------------
  root.querySelectorAll(".pd-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.overlay = null;
      root.querySelectorAll(".pd-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.activeTab = tab.dataset.tab;
      render();
    });
  });

  root.querySelector("#pd-close").addEventListener("click", () => root.classList.add("pd-hidden"));
  root.querySelector("#pd-lib-btn").addEventListener("click", () => { state.overlay = "library"; render(); });
  root.querySelector("#pd-chats-btn").addEventListener("click", () => { state.overlay = "chats"; render(); });
  root.querySelector("#pd-store-btn").addEventListener("click", () => { state.overlay = "store"; state.storeNav = { stream: null, sem: null, subject: null }; render(); });
  fab.addEventListener("click", () => root.classList.toggle("pd-hidden"));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PROMPTDOCK_TOGGLE") root.classList.toggle("pd-hidden");
  });

  // ---- PDF loading & rendering --------------------------------------------
  async function loadPdf(file, opts = {}) {
    const { persist = true } = opts;
    state.currentFile = file;
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
    state.hqCache = null;
    stopAutosolve();
    render();

    if (persist) {
      try {
        const dataUrl = await fileToDataUrl(file);
        await saveToLibrary({ name: file.name, size: file.size, numPages: state.numPages, dataUrl });
      } catch (e) {
        console.warn("[PromptDock] could not save PDF to library:", e);
        showToast("Loaded, but couldn't save to library (storage may be full).");
      }
    }
  }

  function resetPdf() {
    stopAutosolve();
    state.pdfDoc = null;
    state.currentFile = null;
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

    const EDGE = 30;   // px from the visible edge that triggers auto-scroll
    const SPEED = 7;    // max px scrolled per frame, right at the very edge

    // Converts a viewport (clientX/Y) position into overlay-local coordinates
    // that stay correct regardless of current scroll position. wrap's own
    // bounding rect never moves (only its *content* scrolls), so anchoring to
    // it — plus the live scroll offset — avoids the feedback loop you'd get
    // from re-measuring the overlay's rect after every auto-scroll step.
    function toOverlayLocal(clientX, clientY) {
      const wrapRect = wrap.getBoundingClientRect();
      const rawX = clientX - wrapRect.left + wrap.scrollLeft;
      const rawY = clientY - wrapRect.top + wrap.scrollTop;
      // Clamp to the actual page bounds so a selection can never exceed it.
      const x = Math.max(0, Math.min(rawX, overlay.clientWidth));
      const y = Math.max(0, Math.min(rawY, overlay.clientHeight));
      return { x, y };
    }

    function updateSelectionFromClient(clientX, clientY) {
      const { x: curX, y: curY } = toOverlayLocal(clientX, clientY);
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

      if (lastClientX < wrapRect.left + EDGE) {
        const t = (wrapRect.left + EDGE - lastClientX) / EDGE; // 0..1
        dx = -SPEED * t * t; // eased — slow to start, quicker only right at the edge
      } else if (lastClientX > wrapRect.right - EDGE) {
        const t = (lastClientX - (wrapRect.right - EDGE)) / EDGE;
        dx = SPEED * t * t;
      }

      if (lastClientY < wrapRect.top + EDGE) {
        const t = (wrapRect.top + EDGE - lastClientY) / EDGE;
        dy = -SPEED * t * t;
      } else if (lastClientY > wrapRect.bottom - EDGE) {
        const t = (lastClientY - (wrapRect.bottom - EDGE)) / EDGE;
        dy = SPEED * t * t;
      }

      if (dx !== 0 || dy !== 0) {
        const maxLeft = wrap.scrollWidth - wrap.clientWidth;
        const maxTop = wrap.scrollHeight - wrap.clientHeight;
        wrap.scrollLeft = Math.max(0, Math.min(maxLeft, wrap.scrollLeft + dx));
        wrap.scrollTop = Math.max(0, Math.min(maxTop, wrap.scrollTop + dy));
        updateSelectionFromClient(lastClientX, lastClientY);
      }
      scrollRaf = requestAnimationFrame(autoScrollTick);
    }

    overlay.addEventListener("mousedown", (e) => {
      const { x, y } = toOverlayLocal(e.clientX, e.clientY);
      startX = x;
      startY = y;
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

  // ---- autosolve --------------------------------------------------------
  const AUTOSOLVE_COOLDOWN_MS = 3000;

  function getStopButton() {
    return (
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label="Stop generating"]') ||
      document.querySelector('button[aria-label*="Stop"]')
    );
  }

  function isGenerating() {
    return !!getStopButton();
  }

  function submitMessage() {
    const sendBtn =
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label*="Send"]');
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
      return true;
    }
    const editor = getEditor();
    if (!editor) return false;
    ["keydown", "keypress", "keyup"].forEach((type) => {
      editor.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    });
    return true;
  }

  // Polls checkFn until it's true, or bails early if abortFn() becomes true,
  // or gives up after `timeout` ms — whichever comes first.
  function waitForCondition(checkFn, { timeout = 120000, interval = 400, abortFn = () => false } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (abortFn()) return resolve(false);
        if (checkFn()) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function interruptibleSleep(ms, abortFn) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (abortFn() || Date.now() - start >= ms) return resolve();
        setTimeout(tick, 200);
      };
      tick();
    });
  }

  function updateAutosolveStatus(msg) {
    state.autosolve.status = msg;
    const el = bodyEl.querySelector("#pd-autosolve-status");
    if (el) el.textContent = msg;
    updateAutosolveProgress();
  }

  function updateAutosolveProgress() {
    const total = state.questions.length;
    if (!total) return;
    const current = state.autosolve.running
      ? Math.min(state.autosolve.index + 1, total)
      : Math.min(state.autosolve.index, total);
    const percent = Math.round((current / total) * 100);
    const label = bodyEl.querySelector("#pd-autosolve-progress-label");
    const percentEl = bodyEl.querySelector("#pd-autosolve-progress-percent");
    const fill = bodyEl.querySelector("#pd-autosolve-progress-fill");
    const track = bodyEl.querySelector(".pd-progress-track");

    if (label) label.textContent = `Question ${current} of ${total}`;
    if (percentEl) percentEl.textContent = `${percent}%`;
    if (fill) fill.style.width = `${percent}%`;
    if (track) track.setAttribute("aria-valuenow", current);
  }

  function formatDuration(ms) {
    const totalSec = Math.round(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    if (m === 0) return `${s}s`;
    return `${m}m ${s}s`;
  }

  function startAutosolve() {
    if (state.autosolve.running || state.questions.length === 0) return;
    if (state.autosolve.index >= state.questions.length) state.autosolve.index = 0;
    state.autosolve.running = true;
    state.autosolve.expanded = true;
    state.autosolve.startedAt = Date.now();
    render();
    autosolveLoop();
  }

  function stopAutosolve() {
    if (!state.autosolve.running) return;
    state.autosolve.running = false;
    state.autosolve.status = "Stopped.";
    render();
  }

  async function autosolveLoop() {
    const a = state.autosolve;
    const notRunning = () => !state.autosolve.running;

    // Prime the chat with the PDF + any custom instructions, but only once,
    // at the very start of a fresh run — not when resuming after a stop.
    if (a.running && a.index === 0 && a.usePdfContext) {
      if (!state.currentFile) {
        showToast("No PDF file available to attach — continuing without PDF context.");
      } else {
        updateAutosolveStatus("Uploading PDF for context…");
        const attached = attachFileToChat(state.currentFile, { toastMsg: "PDF attached for context ✓" });
        if (attached) {
          await interruptibleSleep(400, notRunning);
          const instruction =
            "Answer all of the following questions based on this PDF only." +
            (a.customInstructions.trim() ? " " + a.customInstructions.trim() : "");
          insertTextToChat(instruction);
          await interruptibleSleep(300, notRunning);
          const sent = submitMessage();
          if (sent) {
            updateAutosolveStatus("Waiting for ChatGPT to process the PDF…");
            // PDFs can take longer to process than a normal reply, so allow more time.
            await waitForCondition(isGenerating, { timeout: 15000, interval: 300, abortFn: notRunning });
            await waitForCondition(() => !isGenerating(), { timeout: 180000, interval: 500, abortFn: notRunning });
            if (a.running) await interruptibleSleep(AUTOSOLVE_COOLDOWN_MS, notRunning);
          } else {
            showToast("Couldn't submit the PDF context message — continuing anyway.");
          }
        }
      }
    }

    while (a.running && a.index < state.questions.length) {
      const q = state.questions[a.index];
      const label = `Q${q.number}${q.unit ? " · " + q.unit : ""} (p.${q.page})`;
      updateAutosolveStatus(`Sending ${label}…`);

      try {
        insertTextToChat(q.text);
        await interruptibleSleep(300, notRunning);
        if (!a.running) break;

        const sent = submitMessage();
        if (!sent) throw new Error("Could not find the send button or chat box");

        updateAutosolveStatus(`Waiting for ChatGPT to answer ${label}…`);
        // Give it a moment to start generating; if it never seems to start,
        // don't get stuck — fall through to the completion wait anyway.
        await waitForCondition(isGenerating, { timeout: 8000, interval: 300, abortFn: notRunning });
        await waitForCondition(() => !isGenerating(), { timeout: 120000, interval: 500, abortFn: notRunning });
      } catch (e) {
        console.warn("[PromptDock] autosolve: skipping question", q.number, e);
        showToast(`Skipped ${label} — couldn't send or detect a reply.`);
      }

      a.index += 1;
      if (!a.running) break;

      if (a.index < state.questions.length) {
        updateAutosolveStatus(`Cooling down 3s before the next question…`);
        await interruptibleSleep(AUTOSOLVE_COOLDOWN_MS, notRunning);
      }
    }

    const finished = a.index >= state.questions.length;
    const elapsed = a.startedAt ? Date.now() - a.startedAt : null;
    a.running = false;
    a.status = finished
      ? `Autosolve complete ✓ — took ${formatDuration(elapsed)} for ${state.questions.length} question${state.questions.length === 1 ? "" : "s"}.`
      : `Stopped${elapsed !== null ? ` after ${formatDuration(elapsed)}` : ""}.`;
    if (finished) a.index = 0;
    render();
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
      state.autosolve.index = 0;
      state.autosolve.status = "";
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

  // Render the initial view right away (even while hidden) so the very first
  // time the panel is opened, the dropzone/tab content is already there and
  // fully interactive — no "warm-up" click needed before it responds.
  render();

  // done — panel is ready but hidden until the toolbar icon or FAB is clicked.
})();
