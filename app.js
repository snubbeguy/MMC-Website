const PREVIEW_BLOCKS_PER_PIXEL = 16;
const PREVIEW_MAX_PIXELS = 25000000;
const EXPORT_MAX_PIXELS = 225030001;
const JPEG_MAX_PIXELS = 100100000;
const MIN_ZOOM = 1;
const MAX_ZOOM = 48;
const DEFAULT_SEED = "2971345700444079891";
const SEED_STORAGE_KEY = "minecraft-map-converter:last-seed";

const form = document.querySelector("#controls");
const seedInput = document.querySelector("#seedInput");
const radiusInput = document.querySelector("#radiusInput");
const formatSelect = document.querySelector("#formatSelect");
const resolutionSelect = document.querySelector("#resolutionSelect");
const previewButton = document.querySelector("#previewButton");
const downloadColoredButton = document.querySelector("#downloadColoredButton");
const downloadUncoloredButton = document.querySelector("#downloadUncoloredButton");
const retryDownloadButton = document.querySelector("#retryDownloadButton");
const downloadDialog = document.querySelector("#downloadDialog");
const downloadDialogTitle = document.querySelector("#downloadDialogTitle");
const closeDownloadDialogButton = document.querySelector("#closeDownloadDialogButton");
const cancelDownloadDialogButton = document.querySelector("#cancelDownloadDialogButton");
const confirmDownloadButton = document.querySelector("#confirmDownloadButton");
const rawCanvas = document.querySelector("#rawCanvas");
const previewCanvas = document.querySelector("#previewCanvas");
const rawContext = rawCanvas.getContext("2d");
const previewContext = previewCanvas.getContext("2d");
const statusText = document.querySelector("#statusText");
const previewSize = document.querySelector("#previewSize");
const downloadSize = document.querySelector("#downloadSize");
const blockSpan = document.querySelector("#blockSpan");

const panes = [
  { canvas: rawCanvas, context: rawContext, sourceKey: "raw" },
  { canvas: previewCanvas, context: previewContext, sourceKey: "mask" },
];
const camera = {
  zoom: 1,
  centerX: 0,
  centerY: 0,
  sourceWidth: 0,
  sourceHeight: 0,
  raw: null,
  mask: null,
  drag: null,
};

let worker = null;
let generatorModulePromise = null;
let busyMode = null;
let lastDownload = null;
let pendingDownloadSource = "uncolored";
let backendMode = location.protocol === "file:" ? "main" : null;

seedInput.value = loadSeedValue();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await generatePreview();
});

previewButton.addEventListener("click", async () => {
  await generatePreview();
});

downloadColoredButton.addEventListener("click", () => {
  openDownloadDialog("colored");
});

downloadUncoloredButton.addEventListener("click", () => {
  openDownloadDialog("uncolored");
});

retryDownloadButton.addEventListener("click", () => {
  if (!lastDownload) return;

  triggerDownload(lastDownload.blob, lastDownload.filename);
  setStatus("Download started again: " + lastDownload.filename);
});

closeDownloadDialogButton.addEventListener("click", closeDownloadDialog);
cancelDownloadDialogButton.addEventListener("click", closeDownloadDialog);
confirmDownloadButton.addEventListener("click", async () => {
  closeDownloadDialog();
  await downloadMap();
});

downloadDialog.addEventListener("click", (event) => {
  if (event.target === downloadDialog) {
    closeDownloadDialog();
  }
});

for (const element of [seedInput, radiusInput, formatSelect, resolutionSelect]) {
  element.addEventListener("input", handleSettingsChange);
  element.addEventListener("change", handleSettingsChange);
}

for (const pane of panes) {
  pane.canvas.addEventListener("wheel", handleWheel, { passive: false });
  pane.canvas.addEventListener("pointerdown", handlePointerDown);
  pane.canvas.addEventListener("pointermove", handlePointerMove);
  pane.canvas.addEventListener("pointerup", handlePointerUp);
  pane.canvas.addEventListener("pointercancel", handlePointerUp);
}

window.addEventListener("resize", () => {
  renderViewports();
});

async function ensureBackend() {
  if (backendMode === "main") {
    return "main";
  }

  if (worker) {
    return "worker";
  }

  try {
    worker = new Worker("./generator.worker.js", { type: "module" });
    worker.addEventListener("message", handleWorkerMessage);
    worker.addEventListener("error", handleWorkerError);
    backendMode = "worker";
    return "worker";
  } catch (error) {
    backendMode = "main";
    setStatus("Using local compatibility mode for previews and downloads.");
    return "main";
  }
}

function handleWorkerMessage(event) {
  const message = event.data;

  if (message.type === "progress") {
    setStatus(message.message);
    return;
  }

  if (message.type === "preview-result") {
    applyPreviewResult(message);
    return;
  }

  if (message.type === "export-result") {
    applyExportResult(message);
    return;
  }

  if (message.type === "error") {
    finishWithError(message.message);
  }
}

function handleWorkerError() {
  if (backendMode === "main") {
    return;
  }

  worker?.terminate();
  worker = null;
  backendMode = "main";
  setBusy(false);
  busyMode = null;
  setStatus("Your browser blocked the background worker for this local file, so the page switched to compatibility mode. Try preview again.", true);
}

async function getGeneratorModule() {
  if (!generatorModulePromise) {
    generatorModulePromise = import("./generator.shared.js");
  }
  return await generatorModulePromise;
}

function handleSettingsChange() {
  saveSeedValue();
  updateMetrics();
  clearLastDownload();
}

function loadSeedValue() {
  try {
    return localStorage.getItem(SEED_STORAGE_KEY) || DEFAULT_SEED;
  } catch (error) {
    return DEFAULT_SEED;
  }
}

function saveSeedValue() {
  try {
    localStorage.setItem(SEED_STORAGE_KEY, seedInput.value.trim());
  } catch (error) {
    // Storage can be unavailable in some local browser modes; the default seed still works.
  }
}

function updateMetrics() {
  const radius = clampRadius(Number.parseInt(radiusInput.value, 10));
  const diameter = radius * 2 + 1;
  const exportScale = Number.parseInt(resolutionSelect.value, 10);
  const previewWidth = Math.ceil(diameter / PREVIEW_BLOCKS_PER_PIXEL);
  const exportWidth = Math.ceil(diameter / exportScale);
  const exportPixels = exportWidth * exportWidth;
  const format = formatSelect.value;

  previewSize.textContent = previewWidth.toLocaleString() + " x " + previewWidth.toLocaleString();
  downloadSize.textContent = exportWidth.toLocaleString() + " x " + exportWidth.toLocaleString();
  blockSpan.textContent = diameter.toLocaleString() + " blocks across";

  if (format === "jpeg" && exportPixels > JPEG_MAX_PIXELS) {
    setStatus("JPEG exports are capped at about 10k x 10k pixels. Use PNG, reduce the radius, or switch to 4 blocks per pixel.", true);
  } else if (exportPixels > EXPORT_MAX_PIXELS) {
    setStatus("PNG exports are capped at about 15k x 15k pixels. Reduce the radius or switch to 4 blocks per pixel.", true);
  } else if (!busyMode) {
    setStatus(location.protocol === "file:" ? "Ready to generate a preview. Local file mode will use compatibility rendering." : "Ready to generate a preview.");
  }
}

function clampRadius(value) {
  if (!Number.isFinite(value) || value < 1) return 1;
  return Math.floor(value);
}

async function generatePreview() {
  if (busyMode) return;

  const payload = buildBasePayload();
  if (!payload) return;

  const diameter = payload.radius * 2 + 1;
  const blocksPerPixel = PREVIEW_BLOCKS_PER_PIXEL;
  const previewWidth = Math.ceil(diameter / blocksPerPixel);
  const previewPixels = previewWidth * previewWidth;

  if (previewPixels > PREVIEW_MAX_PIXELS) {
    setStatus("That fixed 16-block preview is too large to hold interactively in the browser. PNG download still supports up to about 15k x 15k; reduce the radius for preview.", true);
    return;
  }

  busyMode = "preview";
  setBusy(true);
  setStatus("Generating fast paired preview at 1 pixel = 16 blocks...");

  const backend = await ensureBackend();
  if (backend === "worker") {
    worker.postMessage({
      type: "preview",
      seed: payload.seed,
      radius: payload.radius,
      blocksPerPixel,
    });
    return;
  }

  try {
    const generator = await getGeneratorModule();
    const result = await generator.generateMask({
      seed: payload.seed,
      radius: payload.radius,
      blocksPerPixel,
      includeRaw: true,
      onProgress: (message) => setStatus(message),
    });
    applyPreviewResult(result);
  } catch (error) {
    finishWithError(error instanceof Error ? error.message : "Preview failed.");
  }
}

async function downloadMap() {
  if (busyMode) return;

  const payload = buildBasePayload();
  if (!payload) return;

  const source = pendingDownloadSource;
  const format = formatSelect.value;
  const blocksPerPixel = Number.parseInt(resolutionSelect.value, 10);
  const diameter = payload.radius * 2 + 1;
  const outputWidth = Math.ceil(diameter / blocksPerPixel);
  const totalPixels = outputWidth * outputWidth;

  if (format === "jpeg" && totalPixels > JPEG_MAX_PIXELS) {
    setStatus("JPEG export is capped at about 10k x 10k pixels. Use PNG, reduce the radius, or switch to 4 blocks per pixel.", true);
    return;
  }

  if (totalPixels > EXPORT_MAX_PIXELS) {
    setStatus("PNG export is capped at about 15k x 15k pixels. Reduce the radius or switch to 4 blocks per pixel.", true);
    return;
  }

  clearLastDownload();
  busyMode = "download";
  setBusy(true);
  setStatus("Rendering " + labelForSource(source) + " " + format.toUpperCase() + " download...");

  const backend = await ensureBackend();
  if (backend === "worker") {
    worker.postMessage({
      type: "export",
      seed: payload.seed,
      radius: payload.radius,
      blocksPerPixel,
      format,
      source,
    });
    return;
  }

  try {
    const generator = await getGeneratorModule();
    const result = await generator.renderDownload({
      seed: payload.seed,
      radius: payload.radius,
      blocksPerPixel,
      format,
      source,
      onProgress: (message) => setStatus(message),
    });
    applyExportResult(result);
  } catch (error) {
    finishWithError(error instanceof Error ? error.message : "Download failed.");
  }
}

function openDownloadDialog(source = pendingDownloadSource) {
  if (busyMode) return;

  pendingDownloadSource = source;
  downloadDialogTitle.textContent = "Download " + labelForSource(source) + " map";
  confirmDownloadButton.textContent = "Download " + labelForSource(source);
  updateMetrics();
  if (typeof downloadDialog.showModal === "function") {
    downloadDialog.showModal();
  } else {
    downloadDialog.setAttribute("open", "");
  }
}

function closeDownloadDialog() {
  if (downloadDialog.open && typeof downloadDialog.close === "function") {
    downloadDialog.close();
  } else {
    downloadDialog.removeAttribute("open");
  }
}

function buildBasePayload() {
  const seed = seedInput.value.trim();
  const radius = clampRadius(Number.parseInt(radiusInput.value, 10));

  if (!seed) {
    setStatus("Enter a seed first.", true);
    seedInput.focus();
    return null;
  }

  radiusInput.value = String(radius);
  return { seed, radius };
}

function applyPreviewResult(message) {
  busyMode = null;
  setBusy(false);

  const pixels = message.pixels instanceof Uint8Array ? message.pixels : new Uint8Array(message.pixels);
  const rawPixels = message.rawPixels
    ? (message.rawPixels instanceof Uint8Array ? message.rawPixels : new Uint8Array(message.rawPixels))
    : pixels;

  camera.mask = createRgbSourceCanvas(pixels, message.width, message.height);
  camera.raw = createRgbSourceCanvas(rawPixels, message.width, message.height);
  camera.sourceWidth = message.width;
  camera.sourceHeight = message.height;
  resetCamera();

  setStatus("Preview ready in " + formatDuration(message.durationMs) + ". Drag or wheel either map to inspect both together.");
}

function applyExportResult(message) {
  busyMode = null;
  setBusy(false);

  const blob = message.blob instanceof Blob
    ? message.blob
    : new Blob([message.buffer], { type: message.mimeType });
  rememberDownload(blob, message.filename);
  triggerDownload(blob, message.filename);
  setStatus("Download reached 100%. Automatic download started. If it did not appear, use the fallback button.");
}

function finishWithError(message) {
  busyMode = null;
  setBusy(false);
  setStatus(message, true);
}

function rememberDownload(blob, filename) {
  lastDownload = { blob, filename };
  retryDownloadButton.hidden = false;
  retryDownloadButton.disabled = false;
  retryDownloadButton.textContent = "Download " + filename + " again";
}

function clearLastDownload() {
  lastDownload = null;
  retryDownloadButton.hidden = true;
  retryDownloadButton.disabled = true;
  retryDownloadButton.textContent = "Download generated file again";
}

function createRgbSourceCanvas(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const data = image.data;

  for (let index = 0; index < pixels.length / 3; index += 1) {
    const source = index * 3;
    const base = index * 4;
    data[base + 0] = pixels[source + 0];
    data[base + 1] = pixels[source + 1];
    data[base + 2] = pixels[source + 2];
    data[base + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return canvas;
}

function resetCamera() {
  camera.zoom = 1;
  camera.centerX = camera.sourceWidth / 2;
  camera.centerY = camera.sourceHeight / 2;
  renderViewports();
}

function renderViewports() {
  for (const pane of panes) {
    renderPane(pane);
  }
}

function renderPane(pane) {
  const source = camera[pane.sourceKey];
  const canvas = pane.canvas;
  const context = pane.context;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width || canvas.clientWidth || 480);
  const cssHeight = Math.max(1, rect.height || canvas.clientHeight || cssWidth);
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, width, height);

  if (!source) {
    drawEmptyPane(context, width, height);
    return;
  }

  clampCamera(width, height);
  const view = getView(width, height);
  context.drawImage(source, view.x, view.y, view.width, view.height, 0, 0, width, height);
}

function drawEmptyPane(context, width, height) {
  context.fillStyle = "#f5ead0";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(30, 79, 154, 0.18)";
  context.lineWidth = 1;
  for (let x = 0; x < width; x += 28) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y < height; y += 28) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function getView(canvasWidth, canvasHeight) {
  const sourceAspect = camera.sourceWidth / camera.sourceHeight;
  const canvasAspect = canvasWidth / canvasHeight;
  let width;
  let height;

  if (canvasAspect >= sourceAspect) {
    height = camera.sourceHeight / camera.zoom;
    width = height * canvasAspect;
  } else {
    width = camera.sourceWidth / camera.zoom;
    height = width / canvasAspect;
  }

  width = Math.min(camera.sourceWidth, width);
  height = Math.min(camera.sourceHeight, height);

  return {
    x: clamp(camera.centerX - width / 2, 0, Math.max(0, camera.sourceWidth - width)),
    y: clamp(camera.centerY - height / 2, 0, Math.max(0, camera.sourceHeight - height)),
    width,
    height,
  };
}

function clampCamera(canvasWidth = previewCanvas.width, canvasHeight = previewCanvas.height) {
  if (!camera.sourceWidth || !camera.sourceHeight) return;

  const view = getView(canvasWidth, canvasHeight);
  const halfWidth = view.width / 2;
  const halfHeight = view.height / 2;
  camera.centerX = camera.sourceWidth <= view.width
    ? camera.sourceWidth / 2
    : clamp(camera.centerX, halfWidth, camera.sourceWidth - halfWidth);
  camera.centerY = camera.sourceHeight <= view.height
    ? camera.sourceHeight / 2
    : clamp(camera.centerY, halfHeight, camera.sourceHeight - halfHeight);
}

function handleWheel(event) {
  if (!camera.mask) return;

  event.preventDefault();
  const canvas = event.currentTarget;
  const before = screenToSource(canvas, event.offsetX, event.offsetY);
  const zoomDelta = event.deltaY < 0 ? 1.28 : 0.78;
  camera.zoom = clamp(camera.zoom * zoomDelta, MIN_ZOOM, MAX_ZOOM);
  const rect = canvas.getBoundingClientRect();
  const view = getView(canvas.width, canvas.height);
  camera.centerX = before.x - ((event.offsetX / rect.width) - 0.5) * view.width;
  camera.centerY = before.y - ((event.offsetY / rect.height) - 0.5) * view.height;
  clampCamera(canvas.width, canvas.height);
  renderViewports();
}

function handlePointerDown(event) {
  if (!camera.mask) return;

  event.currentTarget.setPointerCapture(event.pointerId);
  camera.drag = {
    canvas: event.currentTarget,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
  };
}

function handlePointerMove(event) {
  if (!camera.drag || camera.drag.pointerId !== event.pointerId || !camera.mask) return;

  const canvas = camera.drag.canvas;
  const rect = canvas.getBoundingClientRect();
  const view = getView(canvas.width, canvas.height);
  const dx = event.clientX - camera.drag.x;
  const dy = event.clientY - camera.drag.y;

  camera.centerX -= (dx / rect.width) * view.width;
  camera.centerY -= (dy / rect.height) * view.height;
  camera.drag.x = event.clientX;
  camera.drag.y = event.clientY;
  clampCamera(canvas.width, canvas.height);
  renderViewports();
}

function handlePointerUp(event) {
  if (!camera.drag || camera.drag.pointerId !== event.pointerId) return;

  camera.drag.canvas.releasePointerCapture(event.pointerId);
  camera.drag = null;
}

function screenToSource(canvas, offsetX, offsetY) {
  const rect = canvas.getBoundingClientRect();
  const view = getView(canvas.width, canvas.height);
  return {
    x: view.x + (offsetX / rect.width) * view.width,
    y: view.y + (offsetY / rect.height) * view.height,
  };
}

function triggerDownload(blob, filename) {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
}

function setBusy(isBusy) {
  previewButton.disabled = isBusy;
  downloadColoredButton.disabled = isBusy;
  downloadUncoloredButton.disabled = isBusy;
  retryDownloadButton.disabled = isBusy || !lastDownload;
  seedInput.disabled = isBusy;
  radiusInput.disabled = isBusy;
  formatSelect.disabled = isBusy;
  resolutionSelect.disabled = isBusy;
  closeDownloadDialogButton.disabled = isBusy;
  cancelDownloadDialogButton.disabled = isBusy;
  confirmDownloadButton.disabled = isBusy;
}

function labelForSource(source) {
  return source === "colored" ? "Colored" : "Uncolored";
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.style.color = isError ? "#ff6b6b" : "";
}

function formatDuration(durationMs) {
  if (durationMs < 1000) {
    return Math.round(durationMs) + " ms";
  }

  return (durationMs / 1000).toFixed(1) + " s";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

updateMetrics();
renderViewports();
