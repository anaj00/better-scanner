/* global cv, PDFLib, JSZip, ScannerGeometry */
(function () {
  "use strict";

  const PROCESSING_WIDTH = 480;
  const AUTO_CAPTURE_STABLE_FRAMES = 6;
  const DETECTION_INTERVAL = 125;
  const PAGE_REMOVED_DELAY = 900;
  const PAGE_CHANGE_DELAY = 450;
  const DEBUG_MODE = new URLSearchParams(location.search).get("debug") === "1";

  const elements = {
    appHeader: document.querySelector("#app-header"),
    welcome: document.querySelector("#welcome-screen"),
    scanner: document.querySelector("#scanner-screen"),
    results: document.querySelector("#results-screen"),
    review: document.querySelector("#review-screen"),
    start: document.querySelector("#start-button"),
    cameraFileButton: document.querySelector("#camera-file-button"),
    cameraFileInput: document.querySelector("#camera-file-input"),
    finishFiles: document.querySelector("#finish-files-button"),
    reset: document.querySelector("#reset-button"),
    scanMore: document.querySelector("#scan-more-button"),
    video: document.querySelector("#camera"),
    outline: document.querySelector("#outline-canvas"),
    status: document.querySelector("#camera-status"),
    menuButton: document.querySelector("#menu-button"),
    scannerMenu: document.querySelector("#scanner-menu"),
    closeMenu: document.querySelector("#close-menu-button"),
    menuDocuments: document.querySelector("#menu-documents"),
    switchCamera: document.querySelector("#switch-camera-button"),
    flashButton: document.querySelector("#flash-button"),
    manualCapture: document.querySelector("#manual-capture-button"),
    undo: document.querySelector("#undo-button"),
    newDocument: document.querySelector("#new-document-button"),
    finish: document.querySelector("#finish-button"),
    documentCount: document.querySelector("#document-count"),
    pageCount: document.querySelector("#page-count"),
    pageSize: document.querySelector("#page-size-select"),
    scanMode: document.querySelector("#scan-mode-select"),
    flash: document.querySelector("#capture-flash"),
    resultTitle: document.querySelector("#results-title"),
    resultList: document.querySelector("#results-list"),
    downloadZip: document.querySelector("#download-zip-button"),
    toast: document.querySelector("#toast"),
    secureNote: document.querySelector("#secure-context-note"),
    reviewImage: document.querySelector("#review-image"),
    reviewCanvas: document.querySelector("#review-canvas"),
    reviewStage: document.querySelector("#review-stage"),
    keepScan: document.querySelector("#keep-scan-button"),
    retake: document.querySelector("#retake-button"),
    resetCorners: document.querySelector("#reset-corners-button"),
    fullImage: document.querySelector("#full-image-button"),
    rotate: document.querySelector("#rotate-button"),
    autoCapture: document.querySelector("#auto-capture-toggle"),
    reviewMode: document.querySelector("#review-mode-select"),
    compare: document.querySelector("#compare-button")
  };

  let stream;
  let cameraFacing = "environment";
  let detectionTimer;
  let opencvReady = false;
  let isCapturing = false;
  let requiresPageChange = false;
  let lastPageSeenAt = 0;
  let stableCorners = [];
  let currentCorners;
  let documentGroups = [[]];
  let generatedFiles = [];
  let toastTimer;
  let torchEnabled = false;
  let detectorBusy = false;
  let detectorRequestId = 0;
  let pendingCapture;
  let reviewCorners;
  let initialReviewCorners;
  let activeReviewCorner = -1;
  let readySince = 0;
  let appPhase = "welcome";
  let detectedCorners = null;
  let displayCorners = null;
  let lastReliableCorners = null;
  let lastDetectorMetrics = null;
  let lastHandledDetectionId = 0;
  let reviewUrl;
  let processedReviewUrl;
  let showingProcessedReview = false;
  let cameraSessionId = 0;
  let activeDetectorRequestId = 0;
  let reviewGeneration = 0;

  const processCanvas = document.createElement("canvas");
  const sourceCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
  let processContext;
  const detectorWorker = typeof Worker === "function" ? new Worker("detector-worker.js") : null;

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    toastTimer = setTimeout(function () { elements.toast.classList.remove("visible"); }, 3200);
  }

  function setScreen(screen) {
    appPhase = screen;
    elements.welcome.hidden = screen !== "welcome";
    elements.scanner.hidden = screen !== "scanner";
    elements.results.hidden = screen !== "results";
    elements.review.hidden = screen !== "review";
    elements.reset.hidden = screen === "welcome";
    elements.appHeader.hidden = screen === "scanner";
    document.body.classList.toggle("scanning", screen === "scanner");
    if (screen !== "scanner") closeMenu();
  }

  function closeMenu() {
    elements.scannerMenu.hidden = true;
    elements.menuButton.setAttribute("aria-expanded", "false");
  }

  function openMenu() {
    renderMenuDocuments();
    elements.scannerMenu.hidden = false;
    elements.menuButton.setAttribute("aria-expanded", "true");
  }

  function totalPages() {
    return documentGroups.reduce(function (count, group) { return count + group.length; }, 0);
  }

  function currentGroup() {
    return documentGroups[documentGroups.length - 1];
  }

  function updateControls() {
    const pages = totalPages();
    const current = currentGroup();
    elements.documentCount.textContent = "Document " + documentGroups.length + " - " + current.length + " " + (current.length === 1 ? "page" : "pages");
    elements.pageCount.textContent = pages + " " + (pages === 1 ? "page" : "pages") + " total";
    elements.undo.disabled = pages === 0;
    elements.newDocument.disabled = current.length === 0;
    elements.finish.disabled = pages === 0;
    elements.finishFiles.hidden = pages === 0;
    renderMenuDocuments();
  }

  function reviewPoints() {
    return reviewCorners || [{ x: .05, y: .05 }, { x: .95, y: .05 }, { x: .95, y: .95 }, { x: .05, y: .95 }];
  }

  function containedImageRect(stageWidth, stageHeight, imageWidth, imageHeight) {
    const scale = Math.min(stageWidth / imageWidth, stageHeight / imageHeight);
    const width = imageWidth * scale; const height = imageHeight * scale;
    return { left: (stageWidth - width) / 2, top: (stageHeight - height) / 2, width: width, height: height };
  }

  function drawReview() {
    const canvas = elements.reviewCanvas;
    const rect = elements.reviewStage.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const imageRect = containedImageRect(rect.width, rect.height, elements.reviewImage.naturalWidth, elements.reviewImage.naturalHeight);
    const points = reviewPoints().map(function (point) { return { x: (imageRect.left + point.x * imageRect.width) * ratio, y: (imageRect.top + point.y * imageRect.height) * ratio }; });
    context.fillStyle = "rgba(0, 0, 0, .42)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-out";
    context.beginPath(); points.forEach(function (point, index) { index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y); }); context.closePath(); context.fill();
    context.globalCompositeOperation = "source-over";
    context.beginPath(); points.forEach(function (point, index) { index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y); }); context.closePath();
    context.strokeStyle = "#d7f770"; context.lineWidth = 3 * ratio; context.stroke();
    points.forEach(function (point) { context.beginPath(); context.arc(point.x, point.y, 12 * ratio, 0, Math.PI * 2); context.fillStyle = "#fff"; context.fill(); context.strokeStyle = "#111714"; context.stroke(); });
  }

  function renderMenuDocuments() {
    elements.menuDocuments.replaceChildren();
    documentGroups.forEach(function (group, index) {
      const row = document.createElement("div");
      row.className = "menu-document";
      const name = document.createElement("span");
      name.textContent = "Document " + (index + 1);
      const count = document.createElement("span");
      count.textContent = group.length ? group.length + " " + (group.length === 1 ? "page" : "pages") : "Ready";
      row.append(name, count);
      elements.menuDocuments.append(row);
    });
  }

  function stopCamera() {
    cameraSessionId += 1;
    clearTimeout(detectionTimer);
    detectionTimer = undefined;
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      stream = undefined;
    }
    elements.video.srcObject = null;
    torchEnabled = false;
    detectorBusy = false;
    readySince = 0;
    detectedCorners = null;
    displayCorners = null;
    lastReliableCorners = null;
    lastHandledDetectionId = 0;
    if (detectorWorker) detectorWorker.postMessage({ type: "reset" });
    elements.flashButton.disabled = true;
    elements.flashButton.textContent = "Flash";
    closeMenu();
  }

  function updateFlashControl() {
    const track = stream && stream.getVideoTracks()[0];
    const capabilities = track && track.getCapabilities ? track.getCapabilities() : undefined;
    const supported = Boolean(capabilities && capabilities.torch);
    elements.flashButton.disabled = !supported;
    elements.flashButton.textContent = torchEnabled ? "Flash on" : "Flash";
    elements.flashButton.title = supported ? "Toggle camera flash" : "Flash is not available in this browser";
  }

  async function toggleFlash() {
    const track = stream && stream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    try {
      const nextValue = !torchEnabled;
      await track.applyConstraints({ advanced: [{ torch: nextValue }] });
      torchEnabled = nextValue;
      updateFlashControl();
    } catch (error) {
      showToast("Flash is not available for this camera in this browser.");
      updateFlashControl();
    }
  }

  function resetSession() {
    reviewGeneration += 1;
    stopCamera();
    if (pendingCapture && pendingCapture.close) pendingCapture.close(); pendingCapture = undefined;
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = undefined;
    if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = undefined;
    documentGroups = [[]];
    generatedFiles.forEach(function (file) { URL.revokeObjectURL(file.url); });
    generatedFiles = [];
    stableCorners = [];
    currentCorners = undefined;
    requiresPageChange = false;
    updateControls();
    setScreen("welcome");
  }

  function waitForOpenCv() {
    return new Promise(function (resolve, reject) {
      const deadline = Date.now() + 15000;
      (function check() {
        if (window.cv && window.cv.Mat) {
          opencvReady = true;
          resolve();
          return;
        }
        if (Date.now() > deadline) {
          reject(new Error("Image processing library did not load"));
          return;
        }
        setTimeout(check, 100);
      })();
    });
  }

  async function startCamera() {
    if (!window.isSecureContext) {
      elements.secureNote.hidden = false;
      showToast("Open this scanner from an HTTPS address to use the camera.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast("This browser does not provide camera access. Try Safari, Chrome, or Samsung Internet.");
      return;
    }

    elements.start.disabled = true;
    elements.start.textContent = "Opening camera...";
    setScreen("scanner");
    closeMenu();
    elements.status.textContent = "Opening camera...";
    try {
      stopCamera();
      const sessionId = cameraSessionId;
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: cameraFacing },
          width: { ideal: 3840 },
          height: { ideal: 2160 }
        }
      };
      const openedStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (sessionId !== cameraSessionId) { openedStream.getTracks().forEach(function (track) { track.stop(); }); return; }
      stream = openedStream;
      elements.video.srcObject = stream;
      await elements.video.play();
      updateFlashControl();
      elements.manualCapture.disabled = true;
      elements.status.textContent = "Starting page detection...";
      waitForOpenCv().then(function () {
        if (!stream) return;
        elements.manualCapture.disabled = false;
        elements.status.textContent = "Finding a page...";
        startDetection();
      }).catch(function () {
        elements.status.textContent = "Camera is ready, but page detection could not load.";
        showToast("The camera opened, but page detection did not load. Check your connection and reload.");
      });
    } catch (error) {
      let message = "Could not open the camera. Try switching cameras or closing other camera apps.";
      if (error && error.name === "NotAllowedError") {
        message = "Camera permission was denied. Allow it in your browser settings and try again.";
      } else if (error && error.name === "NotFoundError") {
        message = "No camera was found on this device.";
      } else if (error && error.name === "NotReadableError") {
        message = "Another app is using the camera. Close it and try again.";
      } else if (error && error.name === "OverconstrainedError") {
        message = "This camera does not support the requested settings. Try switching cameras.";
      }
      showToast(message);
      stopCamera();
      setScreen("welcome");
    } finally {
      elements.start.disabled = false;
      elements.start.textContent = "Open camera";
    }
  }

  function startDetection() {
    clearTimeout(detectionTimer);
    const tick = function () {
      if (!stream) return;
      processFrame();
      detectionTimer = setTimeout(tick, DETECTION_INTERVAL);
    };
    tick();
  }

  function resizeOverlay() {
    const rect = elements.video.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (elements.outline.width !== width || elements.outline.height !== height) {
      elements.outline.width = width;
      elements.outline.height = height;
    }
  }

  function drawOutline(corners, ready, isGuide) {
    resizeOverlay();
    const context = elements.outline.getContext("2d");
    const width = elements.outline.width;
    const height = elements.outline.height;
    context.clearRect(0, 0, width, height);
    if (!corners) return;
    context.beginPath();
    const videoRatio = elements.video.videoWidth / elements.video.videoHeight;
    const frameRatio = width / height;
    const renderedWidth = videoRatio > frameRatio ? height * videoRatio : width;
    const renderedHeight = videoRatio > frameRatio ? height : width / videoRatio;
    const offsetX = (width - renderedWidth) / 2;
    const offsetY = (height - renderedHeight) / 2;
    corners.forEach(function (point, index) {
      const x = offsetX + point.x * renderedWidth;
      const y = offsetY + point.y * renderedHeight;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.lineWidth = Math.max(3, width * .007);
    context.strokeStyle = ready ? "#d9fb70" : (isGuide ? "rgba(255, 255, 255, .72)" : "#ffffff");
    context.setLineDash(isGuide ? [width * .035, width * .025] : []);
    context.shadowColor = "rgba(0, 0, 0, .55)";
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;
    context.setLineDash([]);
  }

  function pageGuideCorners() {
    resizeOverlay();
    const width = elements.outline.width;
    const height = elements.outline.height;
    const videoRatio = elements.video.videoWidth / elements.video.videoHeight;
    const frameRatio = width / height;
    const renderedWidth = videoRatio > frameRatio ? height * videoRatio : width;
    const renderedHeight = videoRatio > frameRatio ? height : width / videoRatio;
    const offsetX = (width - renderedWidth) / 2;
    const offsetY = (height - renderedHeight) / 2;
    const pageRatio = elements.pageSize.value === "a4" ? 210 / 297 : (elements.pageSize.value === "legal" ? 8.5 / 14 : 8.5 / 11);
    let guideWidth = width * .8;
    let guideHeight = guideWidth / pageRatio;
    if (guideHeight > height * .86) {
      guideHeight = height * .86;
      guideWidth = guideHeight * pageRatio;
    }
    const left = (width - guideWidth) / 2;
    const top = (height - guideHeight) / 2;
    const toVideoPoint = function (x, y) {
      return { x: (x - offsetX) / renderedWidth, y: (y - offsetY) / renderedHeight };
    };
    return [
      toVideoPoint(left, top),
      toVideoPoint(left + guideWidth, top),
      toVideoPoint(left + guideWidth, top + guideHeight),
      toVideoPoint(left, top + guideHeight)
    ];
  }

  function guideLabel() {
    if (elements.pageSize.value === "a4") return "A4";
    if (elements.pageSize.value === "letter") return "Letter";
    return "Legal";
  }

  function averageCornerMovement(frames) {
    if (frames.length < 2) return Infinity;
    let movement = 0;
    for (let frame = 1; frame < frames.length; frame += 1) {
      for (let point = 0; point < 4; point += 1) {
        const dx = frames[frame][point].x - frames[frame - 1][point].x;
        const dy = frames[frame][point].y - frames[frame - 1][point].y;
        movement += Math.sqrt(dx * dx + dy * dy);
      }
    }
    return movement / ((frames.length - 1) * 4);
  }

  function processFrame() {
    if (appPhase !== "scanner" || !stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || isCapturing || detectorBusy) return;
    const videoWidth = elements.video.videoWidth;
    const videoHeight = elements.video.videoHeight;
    if (!videoWidth || !videoHeight) return;
    const scale = Math.min(1, PROCESSING_WIDTH / videoWidth);
    const processingWidth = Math.round(videoWidth * scale);
    const processingHeight = Math.round(videoHeight * scale);
    if (processCanvas.width !== processingWidth || processCanvas.height !== processingHeight) {
      processCanvas.width = processingWidth;
      processCanvas.height = processingHeight;
      processContext = processCanvas.getContext("2d", { willReadFrequently: true });
    }
    processContext.drawImage(elements.video, 0, 0, processCanvas.width, processCanvas.height);
    if (!detectorWorker) {
      elements.status.textContent = "Use the capture button if page detection is unavailable.";
      return;
    }
    detectorBusy = true;
    const frameId = detectorRequestId += 1;
    // ImageData works in Safari workers without relying on OffscreenCanvas support.
    const imageData = processContext.getImageData(0, 0, processCanvas.width, processCanvas.height);
    activeDetectorRequestId = frameId;
    detectorWorker.postMessage({ type: "detect", id: frameId, sessionId: cameraSessionId, width: processCanvas.width, height: processCanvas.height, sentAt: performance.now(), buffer: imageData.data.buffer }, [imageData.data.buffer]);
  }

  function handleDetection(result) {
    if (appPhase !== "scanner") { detectorBusy = false; return; }
    if (result.id !== activeDetectorRequestId || result.sessionId !== cameraSessionId || result.id <= lastHandledDetectionId) return;
    detectorBusy = false;
    lastHandledDetectionId = result.id;
    const corners = result.corners;
    const confidence = result.confidence || 0;
    lastDetectorMetrics = result.metrics;
    detectedCorners = corners;
    if (!corners) {
      currentCorners = null;
      displayCorners = null;
      drawOutline(pageGuideCorners(), false, true);
      stableCorners = [];
      readySince = 0;
      if (requiresPageChange && Date.now() - lastPageSeenAt > PAGE_REMOVED_DELAY) {
        requiresPageChange = false;
        elements.status.textContent = "Ready for the next page.";
      } else if (!requiresPageChange) {
        elements.status.textContent = "Finding page edges. Align it to the dashed " + guideLabel() + " guide.";
      }
      return;
    }
    const identityChanged = !displayCorners || Math.hypot(corners.reduce(function (sum, point) { return sum + point.x / 4; }, 0) - displayCorners.reduce(function (sum, point) { return sum + point.x / 4; }, 0), corners.reduce(function (sum, point) { return sum + point.y / 4; }, 0) - displayCorners.reduce(function (sum, point) { return sum + point.y / 4; }, 0)) > .12;
    if (identityChanged) { displayCorners = corners.map(function (point) { return { x: point.x, y: point.y }; }); stableCorners = []; readySince = 0; }
    else displayCorners = corners.map(function (point, index) { return { x: .38 * point.x + .62 * displayCorners[index].x, y: .38 * point.y + .62 * displayCorners[index].y }; });
    currentCorners = corners;
    if (confidence >= .62) lastReliableCorners = corners.map(function (point) { return { x: point.x, y: point.y }; });
    lastPageSeenAt = Date.now();
    stableCorners.push(displayCorners);
    if (stableCorners.length > AUTO_CAPTURE_STABLE_FRAMES) stableCorners.shift();
    const areas = stableCorners.map(function (points) { return Math.abs(ScannerGeometry.signedArea(points)); });
    const areaStable = areas.length && Math.max.apply(null, areas) - Math.min.apply(null, areas) < .025;
    const stable = stableCorners.length >= AUTO_CAPTURE_STABLE_FRAMES && averageCornerMovement(stableCorners) < .005 && areaStable;
    const qualityReady = lastDetectorMetrics && lastDetectorMetrics.areaRatio >= .16 && lastDetectorMetrics.borderMargin >= .008 && lastDetectorMetrics.blurScore >= 45 && lastDetectorMetrics.brightness >= 45 && lastDetectorMetrics.brightness <= 242 && lastDetectorMetrics.overexposure <= .28 && lastDetectorMetrics.underexposure <= .12 && lastDetectorMetrics.glareRatio <= .08;
    if (stable && confidence >= .7 && qualityReady && !requiresPageChange) {
      if (!readySince) readySince = Date.now();
    } else {
      readySince = 0;
    }
    drawOutline(displayCorners, stable && !requiresPageChange);
    if (requiresPageChange) {
      elements.status.textContent = "Move the page away, then show the next one.";
      return;
    }
    const ready = readySince && Date.now() - readySince >= 900;
    let guidance = confidence < .48 ? "Finding page..." : (lastDetectorMetrics && lastDetectorMetrics.areaRatio < .16 ? "Move closer" : (!lastDetectorMetrics || lastDetectorMetrics.blurScore < 45 ? "Hold steady" : (lastDetectorMetrics.brightness < 45 ? "Too dark" : (lastDetectorMetrics.overexposure > .28 || lastDetectorMetrics.glareRatio > .08 ? "Reduce glare" : "Hold steady"))));
    elements.status.textContent = ready ? "Ready. Capturing..." : guidance;
    if (DEBUG_MODE) elements.status.textContent += " | confidence " + confidence.toFixed(2) + " | blur " + Math.round(lastDetectorMetrics.blurScore) + " | mask " + (result.diagnostics && result.diagnostics.maskUsed);
    if (ready && elements.autoCapture.checked) { readySince = 0; captureCurrentPage(lastReliableCorners || corners); }
  }

  function distance(one, two) {
    return Math.hypot(one.x - two.x, one.y - two.y);
  }

  function outputDimensions(corners, sourceWidth, sourceHeight) {
    const points = corners.map(function (point) { return { x: point.x * sourceWidth, y: point.y * sourceHeight }; });
    const width = Math.max(distance(points[0], points[1]), distance(points[3], points[2]));
    const height = Math.max(distance(points[0], points[3]), distance(points[1], points[2]));
    const memory = navigator.deviceMemory || 4; const maximumDimension = memory <= 2 ? 2000 : (memory <= 4 ? 2800 : 3200);
    const maximumPixels = memory <= 2 ? 4000000 : 8000000;
    const scale = Math.min(1, maximumDimension / Math.max(width, height), Math.sqrt(maximumPixels / (width * height)));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("Image encoding failed")); }, type, quality); });
  }

  async function captureHighResolutionStill() {
    const track = stream && stream.getVideoTracks()[0];
    if (window.ImageCapture && track) {
      try {
        const photo = await new ImageCapture(track).takePhoto();
        return await decodeBlobToSource(photo);
      } catch (error) { /* Use the intrinsic video fallback below. */ }
    }
    const canvas = document.createElement("canvas");
    canvas.width = elements.video.videoWidth;
    canvas.height = elements.video.videoHeight;
    canvas.getContext("2d").drawImage(elements.video, 0, 0, canvas.width, canvas.height);
    return typeof createImageBitmap === "function" ? createImageBitmap(canvas) : canvas;
  }

  async function decodeBlobToSource(blob) {
    if (typeof createImageBitmap === "function") {
      try { return await createImageBitmap(blob, { imageOrientation: "from-image" }); }
      catch (error) { /* Use the HTML image decoder below. */ }
    }
    const image = new Image(); const url = URL.createObjectURL(blob); image.src = url;
    try {
      if (image.decode) await image.decode(); else await new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = reject; });
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext("2d").drawImage(image, 0, 0); return canvas;
    } finally { URL.revokeObjectURL(url); }
  }

  async function captureCurrentPage(corners) {
    if (isCapturing) return;
    isCapturing = true;
    elements.status.textContent = "Capturing high-resolution still...";
    const generation = reviewGeneration += 1;
    try {
      const bitmap = await captureHighResolutionStill();
      if (generation !== reviewGeneration) { if (bitmap.close) bitmap.close(); return; }
      pendingCapture = bitmap;
      const mappedCorners = corners ? mapPreviewCornersToStill(corners, elements.video.videoWidth, elements.video.videoHeight, bitmap.width, bitmap.height) : null;
      reviewCorners = mappedCorners ? refineCornersOnStill(bitmap, mappedCorners) : [{ x: .05, y: .05 }, { x: .95, y: .05 }, { x: .95, y: .95 }, { x: .05, y: .95 }];
      initialReviewCorners = reviewCorners.map(function (point) { return { x: point.x, y: point.y }; });
      elements.reviewMode.value = elements.scanMode.value;
      if (reviewUrl) URL.revokeObjectURL(reviewUrl);
      reviewUrl = URL.createObjectURL(await bitmapToBlob(bitmap));
      elements.reviewImage.src = reviewUrl;
      if (elements.reviewImage.decode) await elements.reviewImage.decode();
      else await new Promise(function (resolve, reject) { elements.reviewImage.onload = resolve; elements.reviewImage.onerror = reject; });
      setScreen("review");
      drawReview();
    } catch (error) {
      showToast("Could not capture the high-resolution image. Try again.");
    } finally { isCapturing = false; }
  }

  function mapPreviewCornersToStill(corners, previewWidth, previewHeight, stillWidth, stillHeight) {
    const previewRatio = previewWidth / previewHeight; const stillRatio = stillWidth / stillHeight;
    return corners.map(function (point) {
      if (previewRatio > stillRatio) {
        const visibleHeight = stillRatio / previewRatio;
        return { x: point.x, y: (1 - visibleHeight) / 2 + point.y * visibleHeight };
      }
      if (previewRatio < stillRatio) {
        const visibleWidth = previewRatio / stillRatio;
        return { x: (1 - visibleWidth) / 2 + point.x * visibleWidth, y: point.y };
      }
      return { x: point.x, y: point.y };
    });
  }

  function refineCornersOnStill(bitmap, initial) {
    const canvas = document.createElement("canvas"); const scale = Math.min(1, 1200 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; const gray = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < gray.length; index += 1) gray[index] = Math.round(.299 * pixels[index * 4] + .587 * pixels[index * 4 + 1] + .114 * pixels[index * 4 + 2]);
    let originalSupport = 0; let refinedSupport = 0;
    const lines = initial.map(function (point, side) {
      const next = initial[(side + 1) % 4]; const ax = point.x * canvas.width; const ay = point.y * canvas.height; const bx = next.x * canvas.width; const by = next.y * canvas.height;
      const dx = bx - ax; const dy = by - ay; const length = Math.hypot(dx, dy); const nx = -dy / length; const ny = dx / length; const samples = [];
      for (let step = 2; step <= 18; step += 1) {
        const t = step / 20; const x = ax + dx * t; const y = ay + dy * t; let bestOffset = 0; let bestGradient = 0;
        for (let offset = -18; offset <= 18; offset += 2) {
          const x1 = Math.max(0, Math.min(canvas.width - 1, Math.round(x + nx * (offset - 2)))); const y1 = Math.max(0, Math.min(canvas.height - 1, Math.round(y + ny * (offset - 2))));
          const x2 = Math.max(0, Math.min(canvas.width - 1, Math.round(x + nx * (offset + 2)))); const y2 = Math.max(0, Math.min(canvas.height - 1, Math.round(y + ny * (offset + 2)))); const gradient = Math.abs(gray[y2 * canvas.width + x2] - gray[y1 * canvas.width + x1]);
          if (gradient > bestGradient) { bestGradient = gradient; bestOffset = offset; }
          if (offset === 0) originalSupport += gradient;
        }
        refinedSupport += bestGradient;
        samples.push({ x: x + nx * bestOffset, y: y + ny * bestOffset });
      }
      const center = samples.reduce(function (sum, sample) { return { x: sum.x + sample.x / samples.length, y: sum.y + sample.y / samples.length }; }, { x: 0, y: 0 });
      let xx = 0; let xy = 0; let yy = 0; samples.forEach(function (sample) { const x = sample.x - center.x; const y = sample.y - center.y; xx += x * x; xy += x * y; yy += y * y; });
      const angle = .5 * Math.atan2(2 * xy, xx - yy); const normal = { x: -Math.sin(angle), y: Math.cos(angle) }; return { a: normal.x, b: normal.y, c: -(normal.x * center.x + normal.y * center.y) };
    });
    function intersect(one, two) { const determinant = one.a * two.b - two.a * one.b; if (Math.abs(determinant) < .0001) return null; return { x: (one.b * two.c - two.b * one.c) / determinant / canvas.width, y: (one.c * two.a - two.c * one.a) / determinant / canvas.height }; }
    const refined = ScannerGeometry.orderCorners([intersect(lines[3], lines[0]), intersect(lines[0], lines[1]), intersect(lines[1], lines[2]), intersect(lines[2], lines[3])].filter(Boolean));
    if (!refined) return initial;
    const movement = refined.reduce(function (sum, point, index) { return sum + distance(point, initial[index]); }, 0) / 4;
    return movement <= .08 && refinedSupport > originalSupport * 1.08 ? refined : initial;
  }

  function bitmapToBlob(bitmap) {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvasToBlob(canvas, "image/jpeg", .95);
  }

  function processOriginal(warped, mats) { const output = warped.clone(); mats.push(output); return output; }

  function applyLocalContrast(source, destination, clipLimit) {
    let clahe;
    try { clahe = cv.createCLAHE(clipLimit, new cv.Size(8, 8)); clahe.apply(source, destination); }
    catch (error) { cv.equalizeHist(source, destination); }
    finally { if (clahe) clahe.delete(); }
  }

  function processEnhancedColor(warped, mats) {
    const rgb = new cv.Mat(); const lab = new cv.Mat(); const outputRgb = new cv.Mat(); const output = new cv.Mat(); const channels = new cv.MatVector();
    mats.push(rgb, lab, outputRgb, output, channels);
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); cv.split(lab, channels);
    const luminance = channels.get(0); const background = new cv.Mat(); const normalized = new cv.Mat(); const enhancedL = new cv.Mat(); mats.push(luminance, background, normalized, enhancedL);
    cv.GaussianBlur(luminance, background, new cv.Size(0, 0), Math.max(12, Math.round(Math.max(warped.rows, warped.cols) / 45)));
    cv.divide(luminance, background, normalized, 210);
    applyLocalContrast(normalized, enhancedL, 1.6);
    const channelA = channels.get(1); const channelB = channels.get(2); const merged = new cv.MatVector(); mats.push(channelA, channelB, merged); merged.push_back(enhancedL); merged.push_back(channelA); merged.push_back(channelB);
    cv.merge(merged, lab); cv.cvtColor(lab, outputRgb, cv.COLOR_Lab2RGB); cv.cvtColor(outputRgb, output, cv.COLOR_RGB2RGBA);
    return output;
  }

  function processGrayscale(warped, mats) {
    const gray = new cv.Mat(); const background = new cv.Mat(); const normalized = new cv.Mat(); const output = new cv.Mat(); mats.push(gray, background, normalized, output);
    cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, background, new cv.Size(0, 0), Math.max(12, Math.round(Math.max(warped.rows, warped.cols) / 45))); cv.divide(gray, background, normalized, 215);
    applyLocalContrast(normalized, output, 1.5); return output;
  }

  function processBlackAndWhite(warped, mats) {
    const gray = new cv.Mat(); const background = new cv.Mat(); const normalized = new cv.Mat(); const blurred = new cv.Mat(); const output = new cv.Mat(); mats.push(gray, background, normalized, blurred, output);
    cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, background, new cv.Size(0, 0), Math.max(12, Math.round(Math.max(warped.rows, warped.cols) / 45))); cv.divide(gray, background, normalized, 220); cv.GaussianBlur(normalized, blurred, new cv.Size(3, 3), 0);
    let blockSize = Math.round(Math.min(warped.rows, warped.cols) / 30) | 1; blockSize = Math.max(31, Math.min(81, blockSize));
    cv.adaptiveThreshold(blurred, output, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 10); return output;
  }

  async function capturePage(corners, bitmap) {
    if (isCapturing) return;
    isCapturing = true;
    elements.status.textContent = "Processing page...";
    const mats = [];
    let success = false;
    try {
      const videoWidth = bitmap ? bitmap.width : elements.video.videoWidth;
      const videoHeight = bitmap ? bitmap.height : elements.video.videoHeight;
      sourceCanvas.width = videoWidth;
      sourceCanvas.height = videoHeight;
      sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(bitmap || elements.video, 0, 0, videoWidth, videoHeight);
      const dimensions = outputDimensions(corners, videoWidth, videoHeight);
      if (Math.min(dimensions.width, dimensions.height) < 320) throw new Error("The selected crop is too small");
      const source = cv.imread(sourceCanvas); const warped = new cv.Mat(); mats.push(source, warped);
      const sourcePoints = [];
      corners.forEach(function (point) { sourcePoints.push(point.x * videoWidth, point.y * videoHeight); });
      const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints); const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dimensions.width - 1, 0, dimensions.width - 1, dimensions.height - 1, 0, dimensions.height - 1]); const transform = cv.getPerspectiveTransform(sourceMat, destinationMat); mats.push(sourceMat, destinationMat, transform);
      cv.warpPerspective(source, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const mode = elements.scanMode.value;
      const output = mode === "original" ? processOriginal(warped, mats) : (mode === "enhanced-color" ? processEnhancedColor(warped, mats) : (mode === "grayscale" ? processGrayscale(warped, mats) : processBlackAndWhite(warped, mats)));
      outputCanvas.width = dimensions.width;
      outputCanvas.height = dimensions.height;
      cv.imshow(outputCanvas, output);
      const mimeType = mode === "black-and-white" ? "image/png" : "image/jpeg";
      const blob = await canvasToBlob(outputCanvas, mimeType, .9);
      const effectiveDpi = Math.min(dimensions.width / (dimensions.width > dimensions.height ? 14 : 8.5), dimensions.height / (dimensions.width > dimensions.height ? 8.5 : 14));
      currentGroup().push({ blob: blob, mimeType: mimeType, width: dimensions.width, height: dimensions.height, mode: mode, effectiveDpi: effectiveDpi });
      requiresPageChange = true;
      lastPageSeenAt = Date.now();
      stableCorners = [];
      elements.flash.classList.remove("active");
      void elements.flash.offsetWidth;
      elements.flash.classList.add("active");
      updateControls();
      showToast("Page added to Document " + documentGroups.length + ".");
      success = true;
      setTimeout(function () {
        if (requiresPageChange) elements.status.textContent = "Move the page away, then show the next one.";
      }, PAGE_CHANGE_DELAY);
    } catch (error) {
      showToast("Could not process this page. Try the capture button again.");
      elements.status.textContent = "Ready to try again.";
    } finally {
      mats.reverse().forEach(function (mat) { if (mat) mat.delete(); });
      if (success && bitmap && bitmap.close) bitmap.close();
      sourceCanvas.width = 1; sourceCanvas.height = 1; outputCanvas.width = 1; outputCanvas.height = 1;
      isCapturing = false;
    }
    return success;
  }

  function reviewPointFromEvent(event) {
    const rect = elements.reviewStage.getBoundingClientRect();
    const imageRect = containedImageRect(rect.width, rect.height, elements.reviewImage.naturalWidth, elements.reviewImage.naturalHeight);
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left - imageRect.left) / imageRect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top - imageRect.top) / imageRect.height)) };
  }

  function beginCornerDrag(event) {
    const point = reviewPointFromEvent(event);
    const nearest = reviewPoints().map(function (corner) { return Math.hypot(corner.x - point.x, corner.y - point.y); });
    const index = nearest.indexOf(Math.min.apply(null, nearest));
    if (nearest[index] < .12) { activeReviewCorner = index; elements.reviewCanvas.setPointerCapture(event.pointerId); }
  }

  function moveCorner(event) {
    if (activeReviewCorner < 0) return;
    const candidate = reviewCorners.map(function (point) { return { x: point.x, y: point.y }; });
    candidate[activeReviewCorner] = reviewPointFromEvent(event);
    if (ScannerGeometry.validateQuad(candidate)) reviewCorners = candidate;
    drawReview();
  }

  function endCornerDrag() { activeReviewCorner = -1; }

  async function keepReview() {
    if (!pendingCapture) return;
    reviewGeneration += 1;
    const bitmap = pendingCapture;
    elements.scanMode.value = elements.reviewMode.value;
    pendingCapture = undefined;
    const kept = await capturePage(reviewPoints(), bitmap);
    if (!kept) { pendingCapture = bitmap; return; }
    elements.reviewImage.removeAttribute("src");
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = undefined;
    if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = undefined; showingProcessedReview = false; elements.reviewCanvas.hidden = false;
    setScreen(stream ? "scanner" : "welcome");
    stableCorners = []; readySince = 0; requiresPageChange = true;
  }

  function retakeReview() {
    reviewGeneration += 1;
    if (pendingCapture && pendingCapture.close) pendingCapture.close();
    pendingCapture = undefined;
    elements.reviewImage.removeAttribute("src");
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = undefined;
    if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = undefined; showingProcessedReview = false; elements.reviewCanvas.hidden = false;
    setScreen(stream ? "scanner" : "welcome");
    stableCorners = []; readySince = 0;
  }

  function showOriginalReview() { elements.reviewImage.src = reviewUrl; elements.reviewCanvas.hidden = false; elements.compare.textContent = "Preview processed"; showingProcessedReview = false; }
  function resetReviewCorners() { showOriginalReview(); reviewCorners = initialReviewCorners.map(function (point) { return { x: point.x, y: point.y }; }); drawReview(); }
  function useFullImage() { showOriginalReview(); reviewCorners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]; drawReview(); }

  async function toggleProcessedReview() {
    if (!pendingCapture) return;
    if (showingProcessedReview) {
      showOriginalReview(); drawReview(); return;
    }
    const generation = reviewGeneration; const mats = []; const previewSource = document.createElement("canvas"); const previewOutput = document.createElement("canvas");
    try {
      const sourceScale = Math.min(1, 1400 / Math.max(pendingCapture.width, pendingCapture.height)); previewSource.width = Math.round(pendingCapture.width * sourceScale); previewSource.height = Math.round(pendingCapture.height * sourceScale); previewSource.getContext("2d").drawImage(pendingCapture, 0, 0, previewSource.width, previewSource.height);
      const dimensions = outputDimensions(reviewPoints(), previewSource.width, previewSource.height); const source = cv.imread(previewSource); const warped = new cv.Mat(); mats.push(source, warped);
      const sourcePoints = []; reviewPoints().forEach(function (point) { sourcePoints.push(point.x * previewSource.width, point.y * previewSource.height); });
      const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints); const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,dimensions.width-1,0,dimensions.width-1,dimensions.height-1,0,dimensions.height-1]); const transform = cv.getPerspectiveTransform(sourceMat, destinationMat); mats.push(sourceMat, destinationMat, transform);
      cv.warpPerspective(source, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const mode = elements.reviewMode.value; const output = mode === "original" ? processOriginal(warped, mats) : mode === "enhanced-color" ? processEnhancedColor(warped, mats) : mode === "grayscale" ? processGrayscale(warped, mats) : processBlackAndWhite(warped, mats);
      previewOutput.width = dimensions.width; previewOutput.height = dimensions.height; cv.imshow(previewOutput, output);
      const blob = await canvasToBlob(previewOutput, mode === "black-and-white" ? "image/png" : "image/jpeg", .88);
      if (generation !== reviewGeneration) return;
      if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = URL.createObjectURL(blob); elements.reviewImage.src = processedReviewUrl; elements.reviewCanvas.hidden = true; elements.compare.textContent = "View original"; showingProcessedReview = true;
    } catch (error) { showToast("Could not build the processed preview."); }
    finally { mats.reverse().forEach(function (mat) { if (mat) mat.delete(); }); }
  }

  async function rotateReview() {
    if (!pendingCapture) return;
    reviewGeneration += 1;
    const canvas = document.createElement("canvas"); canvas.width = pendingCapture.height; canvas.height = pendingCapture.width;
    const context = canvas.getContext("2d"); context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(pendingCapture, 0, 0);
    if (pendingCapture.close) pendingCapture.close();
    pendingCapture = typeof createImageBitmap === "function" ? await createImageBitmap(canvas) : canvas;
    reviewCorners = ScannerGeometry.orderCorners(reviewPoints().map(function (point) { return { x: 1 - point.y, y: point.x }; }));
    initialReviewCorners = ScannerGeometry.orderCorners(initialReviewCorners.map(function (point) { return { x: 1 - point.y, y: point.x }; }));
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = URL.createObjectURL(await bitmapToBlob(pendingCapture)); elements.reviewImage.src = reviewUrl;
    if (elements.reviewImage.decode) await elements.reviewImage.decode();
    showOriginalReview();
    drawReview();
  }

  function manualCapture() {
    captureCurrentPage(currentCorners);
  }

  async function openCameraFile(file) {
    if (!file) return;
    try {
      pendingCapture = await decodeBlobToSource(file);
      reviewCorners = [{ x: .05, y: .05 }, { x: .95, y: .05 }, { x: .95, y: .95 }, { x: .05, y: .95 }];
      initialReviewCorners = reviewCorners.map(function (point) { return { x: point.x, y: point.y }; });
      if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = URL.createObjectURL(file); elements.reviewImage.src = reviewUrl;
      if (elements.reviewImage.decode) await elements.reviewImage.decode();
      setScreen("review"); drawReview();
    } catch (error) { showToast("Could not open that camera image."); }
  }

  function undoPage() {
    for (let index = documentGroups.length - 1; index >= 0; index -= 1) {
      if (documentGroups[index].length) {
        documentGroups[index].pop();
        if (documentGroups[index].length === 0 && index === documentGroups.length - 1 && documentGroups.length > 1) documentGroups.pop();
        requiresPageChange = false;
        stableCorners = [];
        updateControls();
        showToast("Last page removed.");
        return;
      }
    }
  }

  function newDocument() {
    if (!currentGroup().length) return;
    documentGroups.push([]);
    updateControls();
    showToast("Document " + documentGroups.length + " starts with the next page.");
  }

  async function generatePdfs() {
    const groups = documentGroups.filter(function (group) { return group.length; });
    if (!groups.length || !window.PDFLib) {
      showToast("PDF generation is not available. Check your connection and try again.");
      return;
    }
    elements.finish.disabled = true;
    elements.finish.textContent = "Making PDFs...";
    try {
      generatedFiles.forEach(function (file) { URL.revokeObjectURL(file.url); });
      generatedFiles = [];
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const pdf = await PDFLib.PDFDocument.create();
        for (const scan of groups[groupIndex]) {
          const bytes = await scan.blob.arrayBuffer();
          const image = scan.mimeType === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          const landscape = scan.width > scan.height; const pageWidth = landscape ? 1008 : 612; const pageHeight = landscape ? 612 : 1008;
          const page = pdf.addPage([pageWidth, pageHeight]); const scale = Math.min(pageWidth / image.width, pageHeight / image.height); const width = image.width * scale; const height = image.height * scale;
          page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width: width, height: height });
        }
        const bytes = await pdf.save({ useObjectStreams: true });
        const fileName = "scan-document-" + String(groupIndex + 1).padStart(2, "0") + ".pdf";
        const blob = new Blob([bytes], { type: "application/pdf" });
        generatedFiles.push({
          name: fileName,
          pages: groups[groupIndex].length,
          modes: groups[groupIndex].map(function (scan) { return scan.mode; }),
          blob: blob,
          url: URL.createObjectURL(blob)
        });
      }
      stopCamera();
      renderResults();
      setScreen("results");
    } catch (error) {
      showToast("Could not create the PDFs. Your pages are still available; try again.");
    } finally {
      elements.finish.textContent = "Finish scans";
      elements.finish.disabled = totalPages() === 0;
    }
  }

  function renderResults() {
    elements.resultTitle.textContent = generatedFiles.length === 1 ? "Your PDF is ready" : "Your PDFs are ready";
    elements.resultList.replaceChildren();
    generatedFiles.forEach(function (file, index) {
      const card = document.createElement("article");
      card.className = "result-card";
      const details = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = "Document " + (index + 1);
      const note = document.createElement("p");
      const modes = new Set(file.modes);
      const mode = modes.size === 1 ? Array.from(modes)[0].replaceAll("-", " ") : "mixed modes";
      note.textContent = file.pages + " " + (file.pages === 1 ? "page" : "pages") + " - " + mode;
      details.append(title, note);
      const actions = document.createElement("div");
      actions.className = "result-actions";
      const share = document.createElement("button");
      share.type = "button";
      share.className = "result-action";
      share.textContent = "Share";
      share.addEventListener("click", function () { shareFile(file); });
      const download = document.createElement("a");
      download.className = "result-action";
      download.href = file.url;
      download.download = file.name;
      download.target = "_blank";
      download.rel = "noopener";
      download.textContent = "Open";
      actions.append(share, download);
      card.append(details, actions);
      elements.resultList.append(card);
    });
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const download = document.createElement("a");
    download.href = url;
    download.download = name;
    document.body.append(download);
    download.click();
    download.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  async function downloadZip() {
    if (!generatedFiles.length || !window.JSZip) {
      showToast("ZIP download is not available. Check your connection and try again.");
      return;
    }
    const originalText = elements.downloadZip.textContent;
    elements.downloadZip.disabled = true;
    elements.downloadZip.textContent = "Preparing ZIP...";
    try {
      const zip = new JSZip();
      generatedFiles.forEach(function (file) { zip.file(file.name, file.blob); });
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
      const name = "scanned-documents.zip";
      const file = new File([blob], name, { type: "application/zip" });
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
        try {
          await navigator.share({ title: "Scanned documents", files: [file] });
          return;
        } catch (error) {
          if (error && error.name === "AbortError") return;
        }
      }
      downloadBlob(blob, name);
      showToast("ZIP download started.");
    } catch (error) {
      showToast("Could not create the ZIP. Try downloading the PDFs separately.");
    } finally {
      elements.downloadZip.disabled = false;
      elements.downloadZip.textContent = originalText;
    }
  }

  async function shareFile(result) {
    const file = new File([result.blob], result.name, { type: "application/pdf" });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({ title: result.name, files: [file] });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }
    const fallback = document.createElement("a");
    fallback.href = result.url;
    fallback.download = result.name;
    fallback.click();
    showToast("Your browser opened the PDF. Use its share or download controls to save it.");
  }

  elements.start.addEventListener("click", startCamera);
  elements.cameraFileButton.addEventListener("click", function () { elements.cameraFileInput.click(); });
  elements.cameraFileInput.addEventListener("change", function () { openCameraFile(elements.cameraFileInput.files && elements.cameraFileInput.files[0]); });
  elements.scanMore.addEventListener("click", resetSession);
  elements.reset.addEventListener("click", resetSession);
  elements.manualCapture.addEventListener("click", manualCapture);
  elements.undo.addEventListener("click", undoPage);
  elements.newDocument.addEventListener("click", newDocument);
  elements.finish.addEventListener("click", generatePdfs);
  elements.finishFiles.addEventListener("click", generatePdfs);
  elements.flashButton.addEventListener("click", toggleFlash);
  elements.downloadZip.addEventListener("click", downloadZip);
  elements.switchCamera.addEventListener("click", function () {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
    startCamera();
  });
  elements.keepScan.addEventListener("click", keepReview);
  elements.retake.addEventListener("click", retakeReview);
  elements.resetCorners.addEventListener("click", resetReviewCorners);
  elements.fullImage.addEventListener("click", useFullImage);
  elements.rotate.addEventListener("click", rotateReview);
  elements.compare.addEventListener("click", toggleProcessedReview);
  elements.reviewMode.addEventListener("change", function () {
    if (showingProcessedReview) { showOriginalReview(); drawReview(); }
  });
  elements.reviewCanvas.addEventListener("pointerdown", beginCornerDrag);
  elements.reviewCanvas.addEventListener("pointermove", moveCorner);
  elements.reviewCanvas.addEventListener("pointerup", endCornerDrag);
  elements.reviewCanvas.addEventListener("pointercancel", endCornerDrag);
  window.addEventListener("resize", function () { if (!elements.review.hidden) drawReview(); });
  elements.menuButton.addEventListener("click", openMenu);
  elements.closeMenu.addEventListener("click", closeMenu);
  elements.scannerMenu.addEventListener("click", function (event) {
    if (event.target === elements.scannerMenu) closeMenu();
  });
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("resize", function () { if (stream) resizeOverlay(); });
  document.addEventListener("visibilitychange", function () {
    clearTimeout(detectionTimer);
    if (!document.hidden && appPhase === "scanner" && stream) startDetection();
  });
  if (detectorWorker) {
    detectorWorker.onmessage = function (event) {
      if (event.data.type === "result") handleDetection(event.data);
      if (event.data.type === "error") {
        detectorBusy = false;
        elements.status.textContent = "Use the capture button if page detection is unavailable.";
        showToast("Detector error: " + event.data.message);
      }
    };
    detectorWorker.onerror = function () {
      detectorBusy = false;
      elements.status.textContent = "Use the capture button if page detection is unavailable.";
      showToast("Automatic detection is unavailable. Manual capture is still ready.");
    };
    detectorWorker.onmessageerror = function () {
      detectorBusy = false;
      showToast("The camera frame could not be sent to the detector. Try reloading the page.");
    };
  }
  updateControls();
  setTimeout(startCamera, 0);
})();
