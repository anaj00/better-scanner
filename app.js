/* global cv, PDFLib, JSZip, ScannerGeometry */
(function () {
  "use strict";

  const PROCESSING_WIDTH = 480;
  const AUTO_CAPTURE_STABLE_FRAMES = 6;
  const DETECTION_INTERVAL = 125;
  const DEBUG_MODE = new URLSearchParams(location.search).get("debug") === "1";
  const HIGH_CONFIDENCE = .82;
  const MEDIUM_CONFIDENCE = .62;
  const SAFE_BORDER_MARGIN = .015;
  const STRONG_EDGE_SUPPORT = .55;
  const DUPLICATE_DISTANCE = 5;
  const REARM_DIFFERENCE = 14;
  const REARM_DIFFERENT_FRAMES = 3;
  const MAX_PROCESS_QUEUE = 6;

  const elements = {
    appHeader: document.querySelector("#app-header"),
    welcome: document.querySelector("#welcome-screen"),
    scanner: document.querySelector("#scanner-screen"),
    results: document.querySelector("#results-screen"),
    review: document.querySelector("#review-screen"),
    flagged: document.querySelector("#flagged-screen"),
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
    compare: document.querySelector("#compare-button"),
    filmstrip: document.querySelector("#page-filmstrip"),
    captureFeedback: document.querySelector("#capture-feedback"),
    captureFeedbackText: document.querySelector("#capture-feedback-text"),
    captureFeedbackUndo: document.querySelector("#capture-feedback-undo"),
    reviewTitle: document.querySelector("#review-title"),
    deletePage: document.querySelector("#delete-page-button"),
    flaggedList: document.querySelector("#flagged-list"),
    reviewFlagged: document.querySelector("#review-flagged-button"),
    continueAnyway: document.querySelector("#continue-anyway-button")
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
  let lastDetectionConfidence = 0;
  let lastHandledDetectionId = 0;
  let reviewUrl;
  let processedReviewUrl;
  let showingProcessedReview = false;
  let cameraSessionId = 0;
  let activeDetectorRequestId = 0;
  let reviewGeneration = 0;
  let reviewRotation = 0;
  let pageSequence = 0;
  let processingQueue = [];
  let processingBusy = false;
  let processingWorkerReady = false;
  let activeProcessingJob = null;
  let sessionGeneration = 1;
  let reviewPageId = null;
  let reviewReturnPhase = "scanner";
  let flaggedReviewIds = [];
  let finishing = false;
  let lastCapturedFingerprint = null;
  let lastCapturedGeometry = null;
  let replacementDifferenceFrames = 0;
  let pageAbsentSince = 0;
  let feedbackTimer;
  let detectorWorker = null;
  let processingWorker = null;
  let detectorWorkerRestarts = 0;
  let processingWorkerRestarts = 0;
  let processingReadyTimer;

  const processCanvas = document.createElement("canvas");
  let processContext;

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
    elements.flagged.hidden = screen !== "flagged";
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

  function allPages() { return documentGroups.reduce(function (pages, group) { return pages.concat(group); }, []); }
  function findPage(pageId) { return allPages().find(function (page) { return page.id === pageId; }); }
  function makeId() { return self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2); }

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
    renderFilmstrip();
  }

  function renderFilmstrip() {
    const pages = allPages(); elements.filmstrip.replaceChildren();
    pages.forEach(function (page, index) {
      const button = document.createElement("button"); button.type = "button"; button.className = "filmstrip-page " + page.status + " " + page.cropStatus; button.dataset.pageId = page.id; button.setAttribute("role", "listitem"); button.setAttribute("aria-label", "Review page " + (index + 1));
      if (page.thumbnailUrl) { const image = document.createElement("img"); image.src = page.thumbnailUrl; image.alt = ""; button.append(image); }
      const number = document.createElement("span"); number.className = "page-number"; number.textContent = String(index + 1); button.append(number);
      if (page.cropStatus !== "accepted" || page.status === "error") { const badge = document.createElement("span"); badge.className = "page-badge"; badge.title = page.cropStatus === "needs-crop" ? "Needs crop" : "Check crop"; button.append(badge); }
      elements.filmstrip.append(button);
    });
    const latest = elements.filmstrip.lastElementChild; if (latest) latest.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
  }

  function disposePage(page) {
    page.revision += 1;
    if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl);
    page.thumbnailUrl = null; page.originalImage = null; page.processedImage = null; page.thumbnailBlob = null;
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
    sessionGeneration += 1;
    stopCamera();
    clearTimeout(processingReadyTimer);
    if (processingWorker) processingWorker.terminate();
    processingWorker = null; processingWorkerReady = false; processingBusy = false; activeProcessingJob = null;
    processingWorkerRestarts = 0; startProcessingWorker();
    if (pendingCapture && pendingCapture.close) pendingCapture.close(); pendingCapture = undefined;
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = undefined;
    if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = undefined;
    allPages().forEach(disposePage);
    documentGroups = [[]]; processingQueue = []; processingBusy = false; pageSequence = 0; reviewPageId = null; flaggedReviewIds = []; finishing = false; lastCapturedFingerprint = null; lastCapturedGeometry = null; replacementDifferenceFrames = 0;
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

  function fingerprintFromFrame(corners) {
    if (!processContext || !corners) return null;
    const minX = Math.max(0, Math.min.apply(null, corners.map(function (point) { return point.x; }))); const maxX = Math.min(1, Math.max.apply(null, corners.map(function (point) { return point.x; })));
    const minY = Math.max(0, Math.min.apply(null, corners.map(function (point) { return point.y; }))); const maxY = Math.min(1, Math.max.apply(null, corners.map(function (point) { return point.y; })));
    const width = Math.max(2, Math.round((maxX - minX) * processCanvas.width)); const height = Math.max(2, Math.round((maxY - minY) * processCanvas.height));
    const canvas = document.createElement("canvas"); canvas.width = 9; canvas.height = 8; const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(processCanvas, Math.round(minX * processCanvas.width), Math.round(minY * processCanvas.height), width, height, 0, 0, 9, 8);
    const data = context.getImageData(0, 0, 9, 8).data; const luma = []; let total = 0;
    for (let index = 0; index < 72; index += 1) { const value = .299 * data[index * 4] + .587 * data[index * 4 + 1] + .114 * data[index * 4 + 2]; luma.push(value); total += value; }
    let bits = ""; for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) bits += luma[y * 9 + x] > luma[y * 9 + x + 1] ? "1" : "0";
    return { bits: bits, mean: total / 72, aspect: width / height };
  }

  function fingerprintDistance(one, two) {
    if (!one || !two || Math.abs(one.aspect - two.aspect) / Math.max(one.aspect, two.aspect) > .18 || Math.abs(one.mean - two.mean) > 42) return 64;
    let difference = 0; for (let index = 0; index < one.bits.length; index += 1) if (one.bits[index] !== two.bits[index]) difference += 1; return difference;
  }

  function geometryForCorners(corners) {
    return { centroid: corners.reduce(function (sum, point) { return { x: sum.x + point.x / 4, y: sum.y + point.y / 4 }; }, { x: 0, y: 0 }), area: Math.abs(ScannerGeometry.signedArea(corners)) };
  }

  function rearmCapture() {
    requiresPageChange = false; replacementDifferenceFrames = 0; pageAbsentSince = 0; stableCorners = []; readySince = 0; elements.status.textContent = "Hold steady";
    if (DEBUG_MODE && performance.mark) performance.mark("scanner-rearmed");
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
    lastDetectionConfidence = confidence;
    lastDetectorMetrics = result.metrics;
    detectedCorners = corners;
    if (!corners) {
      currentCorners = null;
      displayCorners = null;
      drawOutline(pageGuideCorners(), false, true);
      stableCorners = [];
      readySince = 0;
      if (requiresPageChange) {
        if (!pageAbsentSince) pageAbsentSince = Date.now();
        if (Date.now() - pageAbsentSince >= 300) rearmCapture();
        else elements.status.textContent = "Replace the page";
      } else if (!requiresPageChange) {
        elements.status.textContent = "Finding page edges. Align it to the dashed " + guideLabel() + " guide.";
      }
      return;
    }
    pageAbsentSince = 0;
    const identityChanged = !displayCorners || Math.hypot(corners.reduce(function (sum, point) { return sum + point.x / 4; }, 0) - displayCorners.reduce(function (sum, point) { return sum + point.x / 4; }, 0), corners.reduce(function (sum, point) { return sum + point.y / 4; }, 0) - displayCorners.reduce(function (sum, point) { return sum + point.y / 4; }, 0)) > .12;
    if (identityChanged) { displayCorners = corners.map(function (point) { return { x: point.x, y: point.y }; }); stableCorners = []; readySince = 0; }
    else displayCorners = corners.map(function (point, index) { return { x: .38 * point.x + .62 * displayCorners[index].x, y: .38 * point.y + .62 * displayCorners[index].y }; });
    currentCorners = corners;
    if (confidence >= .62) lastReliableCorners = corners.map(function (point) { return { x: point.x, y: point.y }; });
    lastPageSeenAt = Date.now();
    if (requiresPageChange) {
      const fingerprint = fingerprintFromFrame(corners); const geometry = geometryForCorners(corners); const centroidChange = lastCapturedGeometry ? distance(geometry.centroid, lastCapturedGeometry.centroid) : 0; const areaChange = lastCapturedGeometry ? Math.abs(geometry.area - lastCapturedGeometry.area) / Math.max(geometry.area, lastCapturedGeometry.area) : 0;
      if (fingerprintDistance(fingerprint, lastCapturedFingerprint) >= REARM_DIFFERENCE || centroidChange >= .08 || areaChange >= .16) replacementDifferenceFrames += 1; else replacementDifferenceFrames = 0;
      drawOutline(displayCorners, false); elements.status.textContent = "Replace the page";
      if (replacementDifferenceFrames >= REARM_DIFFERENT_FRAMES) rearmCapture();
      return;
    }
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
    const ready = readySince && Date.now() - readySince >= 900;
    let guidance = confidence < .48 ? "Finding page..." : (lastDetectorMetrics && lastDetectorMetrics.areaRatio < .16 ? "Move closer" : (!lastDetectorMetrics || lastDetectorMetrics.blurScore < 45 ? "Hold steady" : (lastDetectorMetrics.brightness < 45 ? "Too dark" : (lastDetectorMetrics.overexposure > .28 || lastDetectorMetrics.glareRatio > .08 ? "Reduce glare" : "Hold steady"))));
    elements.status.textContent = ready ? "Ready. Capturing..." : guidance;
    if (DEBUG_MODE) elements.status.textContent += " | confidence " + confidence.toFixed(2) + " | blur " + Math.round(lastDetectorMetrics.blurScore) + " | mask " + (result.diagnostics && result.diagnostics.maskUsed);
    if (ready && elements.autoCapture.checked) { readySince = 0; captureCurrentPage(lastReliableCorners || corners, "auto"); }
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
        return await new ImageCapture(track).takePhoto();
      } catch (error) { /* Use the intrinsic video fallback below. */ }
    }
    const canvas = document.createElement("canvas");
    canvas.width = elements.video.videoWidth;
    canvas.height = elements.video.videoHeight;
    canvas.getContext("2d").drawImage(elements.video, 0, 0, canvas.width, canvas.height);
    return canvasToBlob(canvas, "image/jpeg", .95);
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

  function qualityWarnings(metrics) {
    const warnings = [];
    if (!metrics) return ["No detector metrics"];
    if (metrics.blurScore < 45) warnings.push("Blurry");
    if (metrics.brightness < 45) warnings.push("Too dark");
    if (metrics.overexposure > .28 || metrics.glareRatio > .08) warnings.push("Glare or overexposure");
    if (metrics.borderMargin < SAFE_BORDER_MARGIN) warnings.push("Page may be clipped");
    if (metrics.edgeScore < STRONG_EDGE_SUPPORT) warnings.push("Weak page edges");
    return warnings;
  }

  function classifyCrop(confidence, corners, metrics, source) {
    const valid = Boolean(corners && ScannerGeometry.validateQuad(corners)); const safe = metrics && metrics.borderMargin >= SAFE_BORDER_MARGIN; const strongEdges = metrics && metrics.edgeScore >= STRONG_EDGE_SUPPORT;
    if (confidence >= HIGH_CONFIDENCE && valid && safe && strongEdges) return "accepted";
    if (valid && confidence >= MEDIUM_CONFIDENCE) return "check";
    return "needs-crop";
  }

  function showCaptureFeedback(page) {
    clearTimeout(feedbackTimer); elements.captureFeedbackText.textContent = "Page " + totalPages() + " captured"; elements.captureFeedback.hidden = false;
    feedbackTimer = setTimeout(function () { elements.captureFeedback.hidden = true; }, 2800);
    elements.flash.classList.remove("active"); void elements.flash.offsetWidth; elements.flash.classList.add("active");
    if (navigator.vibrate) navigator.vibrate(35);
  }

  async function makeImmediateThumbnail(page, corners) {
    try {
      const minX = Math.max(0, Math.min.apply(null, corners.map(function (point) { return point.x; }))); const maxX = Math.min(1, Math.max.apply(null, corners.map(function (point) { return point.x; })));
      const minY = Math.max(0, Math.min.apply(null, corners.map(function (point) { return point.y; }))); const maxY = Math.min(1, Math.max.apply(null, corners.map(function (point) { return point.y; })));
      const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 160; canvas.getContext("2d").drawImage(processCanvas, minX * processCanvas.width, minY * processCanvas.height, Math.max(2, (maxX - minX) * processCanvas.width), Math.max(2, (maxY - minY) * processCanvas.height), 0, 0, canvas.width, canvas.height);
      const revision = page.revision; const thumbnailBlob = await canvasToBlob(canvas, "image/jpeg", .72); if (!findPage(page.id) || page.revision !== revision || page.processedImage) return; page.thumbnailBlob = thumbnailBlob; if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl); page.thumbnailUrl = URL.createObjectURL(page.thumbnailBlob); renderFilmstrip();
    } catch (error) { /* Placeholder remains until processing completes. */ }
  }

  async function captureCurrentPage(corners, source) {
    if (isCapturing || finishing || totalPages() >= 50) return;
    if (processingQueue.length >= MAX_PROCESS_QUEUE) { if (source === "manual") showToast("Still processing previous pages."); elements.status.textContent = "Processing previous pages..."; return; }
    isCapturing = true;
    elements.status.textContent = "Capturing high-resolution still...";
    const started = performance.now(); const generation = sessionGeneration; const targetGroup = currentGroup(); const previewWidth = elements.video.videoWidth; const previewHeight = elements.video.videoHeight;
    const chosenCorners = corners && ScannerGeometry.validateQuad(corners) ? corners.map(function (point) { return { x: point.x, y: point.y }; }) : pageGuideCorners();
    const fingerprint = fingerprintFromFrame(chosenCorners); const detectionConfidence = source === "manual" ? lastDetectionConfidence : lastDetectionConfidence; const metrics = lastDetectorMetrics ? Object.assign({}, lastDetectorMetrics) : null; const mode = elements.scanMode.value;
    try {
      const originalImage = await captureHighResolutionStill();
      if (generation !== sessionGeneration) return;
      if (source === "auto" && fingerprintDistance(fingerprint, lastCapturedFingerprint) <= DUPLICATE_DISTANCE) { showToast("Page already captured"); return; }
      const duplicateDistance = fingerprintDistance(fingerprint, lastCapturedFingerprint); const warnings = qualityWarnings(metrics); let cropStatus = classifyCrop(detectionConfidence, corners, metrics, source); if (source !== "auto" && duplicateDistance <= DUPLICATE_DISTANCE) { cropStatus = cropStatus === "needs-crop" ? cropStatus : "check"; warnings.push("Possible duplicate page"); }
      const page = { id: makeId(), revision: 1, sequence: pageSequence += 1, originalImage: originalImage, detectedCorners: chosenCorners, refinedCorners: null, finalCorners: chosenCorners, detectionConfidence: detectionConfidence, refinementConfidence: 0, cropStatus: cropStatus, qualityWarnings: warnings, processedImage: null, processedMimeType: null, processedWidth: 0, processedHeight: 0, rotation: 0, scanMode: mode, status: "captured", fingerprint: fingerprint, previewWidth: previewWidth, previewHeight: previewHeight, sourceWidth: 0, sourceHeight: 0, thumbnailBlob: null, thumbnailUrl: null, processingAttempts: 0, timings: { stillCaptureMs: performance.now() - started }, cancelled: false };
      page.createdAt = started;
      targetGroup.push(page); requiresPageChange = true; lastCapturedFingerprint = fingerprint; lastCapturedGeometry = geometryForCorners(chosenCorners); replacementDifferenceFrames = 0; pageAbsentSince = 0; stableCorners = []; readySince = 0;
      makeImmediateThumbnail(page, chosenCorners); updateControls(); showCaptureFeedback(page); elements.status.textContent = "Replace the page";
      processingQueue.push({ pageId: page.id, revision: page.revision, generation: sessionGeneration }); pumpProcessingQueue();
      if (DEBUG_MODE) console.debug("capture admitted", page.id, page.timings);
    } catch (error) {
      showToast("Could not capture the high-resolution image. Try again.");
    } finally { isCapturing = false; if (finishing) maybeCompleteFinish(); if (DEBUG_MODE) console.debug("camera rearmed after", Math.round(performance.now() - started), "ms"); }
  }

  function processingJobMatches(job) {
    return Boolean(job && activeProcessingJob && job.pageId === activeProcessingJob.pageId && job.revision === activeProcessingJob.revision && job.generation === activeProcessingJob.generation);
  }

  function releaseProcessingJob(job) {
    if (!processingJobMatches(job)) return;
    processingBusy = false; activeProcessingJob = null; pumpProcessingQueue();
    if (finishing) maybeCompleteFinish();
  }

  function pumpProcessingQueue() {
    if (!processingWorker && processingQueue.length) {
      markProcessingUnavailable();
      return;
    }
    if (processingBusy || !processingWorkerReady || !processingQueue.length) return;
    const job = processingQueue.shift(); const page = findPage(job.pageId);
    if (!page || page.cancelled || page.revision !== job.revision || job.generation !== sessionGeneration) { pumpProcessingQueue(); return; }
    processingBusy = true; page.status = "processing"; page.processingAttempts += 1; renderFilmstrip();
    activeProcessingJob = job;
    prepareProcessingJob(page, job).catch(function (error) { handleProcessingFailure(page, job, error); });
  }

  async function prepareProcessingJob(page, job) {
    const started = performance.now(); const source = await decodeBlobToSource(page.originalImage);
    try {
      if (!findPage(page.id) || page.revision !== job.revision || !processingJobMatches(job)) { releaseProcessingJob(job); return; }
      page.sourceWidth = source.width; page.sourceHeight = source.height;
      const corners = page.cornersAreStill ? page.finalCorners : mapPreviewCornersToStill(page.finalCorners, page.previewWidth, page.previewHeight, source.width, source.height);
      page.finalCorners = corners; page.cornersAreStill = true;
      const memory = navigator.deviceMemory || 4; const maximumInput = memory <= 2 ? 2400 : 4000; const maximumInputPixels = memory <= 2 ? 5000000 : 12000000; const scale = Math.min(1, maximumInput / Math.max(source.width, source.height), Math.sqrt(maximumInputPixels / (source.width * source.height)));
      const canvas = document.createElement("canvas"); canvas.width = Math.round(source.width * scale); canvas.height = Math.round(source.height * scale); const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(source, 0, 0, canvas.width, canvas.height); const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      page.timings.sourcePreservationMs = performance.now() - started;
      processingWorker.postMessage({ type: "process", pageId: page.id, revision: page.revision, generation: job.generation, width: canvas.width, height: canvas.height, buffer: imageData.data.buffer, corners: corners, rotation: page.rotation || 0, mode: page.scanMode, maximumDimension: memory <= 2 ? 2000 : (memory <= 4 ? 2800 : 3200), maximumPixels: memory <= 2 ? 4000000 : 8000000 }, [imageData.data.buffer]);
      canvas.width = 0; canvas.height = 0;
    } finally { if (source.close) source.close(); }
  }

  async function applyProcessingResult(result) {
    if (!processingJobMatches(result)) return;
    const page = findPage(result.pageId);
    if (!page || page.cancelled || page.revision !== result.revision) { releaseProcessingJob(result); return; }
    const encodingStarted = performance.now();
    let failure;
    try {
      const canvas = document.createElement("canvas"); canvas.width = result.width; canvas.height = result.height; const context = canvas.getContext("2d"); context.putImageData(new ImageData(new Uint8ClampedArray(result.buffer), result.width, result.height), 0, 0);
      const processedImage = await canvasToBlob(canvas, result.mimeType, .9);
      const thumb = document.createElement("canvas"); const scale = Math.min(1, 240 / Math.max(result.width, result.height)); thumb.width = Math.max(1, Math.round(result.width * scale)); thumb.height = Math.max(1, Math.round(result.height * scale)); thumb.getContext("2d").drawImage(canvas, 0, 0, thumb.width, thumb.height); const thumbnailBlob = await canvasToBlob(thumb, "image/jpeg", .76);
      if (!findPage(page.id) || page.revision !== result.revision || !processingJobMatches(result)) { releaseProcessingJob(result); return; }
      page.processedImage = processedImage; page.processedMimeType = result.mimeType; page.processedWidth = result.width; page.processedHeight = result.height; page.refinedCorners = result.refinedCorners; page.refinementConfidence = result.refinementConfidence; page.finalCorners = result.refinedCorners; page.thumbnailBlob = thumbnailBlob;
      if (page.thumbnailUrl) URL.revokeObjectURL(page.thumbnailUrl); page.thumbnailUrl = URL.createObjectURL(thumbnailBlob);
      if (result.refinementConflict && page.cropStatus === "accepted" && !page.cropManuallyAccepted) { page.cropStatus = "check"; page.qualityWarnings.push("Corner refinement disagreed"); }
      page.status = "ready"; page.timings = Object.assign(page.timings, result.timings, { encodingMs: performance.now() - encodingStarted, totalReadyMs: performance.now() - (page.createdAt || encodingStarted) });
      canvas.width = 0; canvas.height = 0; thumb.width = 0; thumb.height = 0; renderFilmstrip(); updateControls();
      if (DEBUG_MODE) console.debug("page ready", page.id, page.timings);
    } catch (error) { failure = error; }
    if (failure) { handleProcessingFailure(page, result, failure); return; }
    releaseProcessingJob(result);
  }

  function handleProcessingFailure(page, job, error) {
    if (!processingJobMatches(job)) return;
    processingBusy = false;
    activeProcessingJob = null;
    if (!page || !findPage(page.id) || page.revision !== job.revision) { pumpProcessingQueue(); return; }
    if (page.processingAttempts < 2) { page.status = "captured"; processingQueue.unshift(job); }
    else { page.status = "error"; page.cropStatus = "needs-crop"; page.qualityWarnings.push("Processing failed: " + (error.message || error)); }
    renderFilmstrip(); pumpProcessingQueue(); if (finishing) maybeCompleteFinish();
  }

  function markProcessingUnavailable() {
    const jobs = activeProcessingJob ? [activeProcessingJob].concat(processingQueue) : processingQueue.slice();
    const pageIds = new Set(jobs.map(function (job) { return job.pageId; }));
    pageIds.forEach(function (pageId) {
      const page = findPage(pageId);
      if (!page) return;
      page.status = "error";
      page.cropStatus = "needs-crop";
      if (!page.qualityWarnings.includes("Background processing is unavailable")) page.qualityWarnings.push("Background processing is unavailable");
    });
    processingQueue = [];
    processingBusy = false;
    activeProcessingJob = null;
    renderFilmstrip();
    if (finishing) maybeCompleteFinish();
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

  function bitmapToBlob(bitmap) {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    return canvasToBlob(canvas, "image/jpeg", .95);
  }

  async function pdfImageForPage(scan) {
    if (scan.processedImage) return { blob: scan.processedImage, mimeType: scan.processedMimeType };
    const source = await decodeBlobToSource(scan.originalImage); const mats = [];
    try {
      let corners = scan.finalCorners;
      if (!scan.cornersAreStill && corners && scan.previewWidth && scan.previewHeight) corners = mapPreviewCornersToStill(corners, scan.previewWidth, scan.previewHeight, source.width, source.height);
      const rotation = scan.rotation || 0; const oriented = document.createElement("canvas"); oriented.width = rotation % 2 ? source.height : source.width; oriented.height = rotation % 2 ? source.width : source.height; const context = oriented.getContext("2d");
      if (rotation === 1) { context.translate(oriented.width, 0); context.rotate(Math.PI / 2); }
      else if (rotation === 2) { context.translate(oriented.width, oriented.height); context.rotate(Math.PI); }
      else if (rotation === 3) { context.translate(0, oriented.height); context.rotate(-Math.PI / 2); }
      context.drawImage(source, 0, 0);
      if (!window.cv || !cv.Mat || !corners || !ScannerGeometry.validateQuad(corners)) return { blob: await canvasToBlob(oriented, "image/jpeg", .92), mimeType: "image/jpeg" };
      const dimensions = outputDimensions(corners, oriented.width, oriented.height); const sourceMat = cv.imread(oriented); const warped = new cv.Mat(); mats.push(sourceMat, warped); const sourcePoints = [];
      corners.forEach(function (point) { sourcePoints.push(point.x * oriented.width, point.y * oriented.height); });
      const sourcePointsMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints); const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,dimensions.width-1,0,dimensions.width-1,dimensions.height-1,0,dimensions.height-1]); const transform = cv.getPerspectiveTransform(sourcePointsMat, destinationMat); mats.push(sourcePointsMat, destinationMat, transform);
      cv.warpPerspective(sourceMat, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const output = document.createElement("canvas"); output.width = dimensions.width; output.height = dimensions.height; cv.imshow(output, warped);
      return { blob: await canvasToBlob(output, "image/jpeg", .92), mimeType: "image/jpeg" };
    } finally { mats.reverse().forEach(function (mat) { if (mat) mat.delete(); }); if (source.close) source.close(); }
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

  async function rotateBitmapClockwise(bitmap) {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.height; canvas.height = bitmap.width; const context = canvas.getContext("2d"); context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(bitmap, 0, 0); if (bitmap.close) bitmap.close(); return typeof createImageBitmap === "function" ? createImageBitmap(canvas) : canvas;
  }

  async function openPageEditor(pageId, returnPhase) {
    const page = findPage(pageId); if (!page || !page.originalImage) return;
    reviewGeneration += 1; const generation = reviewGeneration; reviewPageId = pageId; reviewReturnPhase = returnPhase || "scanner";
    try {
      if (pendingCapture && pendingCapture.close) pendingCapture.close(); pendingCapture = undefined;
      let capture = await decodeBlobToSource(page.originalImage);
      if (generation !== reviewGeneration || reviewPageId !== pageId) { if (capture.close) capture.close(); return; }
      reviewRotation = page.rotation || 0;
      for (let turn = 0; turn < reviewRotation; turn += 1) capture = await rotateBitmapClockwise(capture);
      if (generation !== reviewGeneration || reviewPageId !== pageId) { if (capture.close) capture.close(); return; }
      pendingCapture = capture;
      let editorCorners = page.finalCorners || page.detectedCorners || [{x:.03,y:.03},{x:.97,y:.03},{x:.97,y:.97},{x:.03,y:.97}];
      if (!page.cornersAreStill && page.previewWidth && page.previewHeight) editorCorners = mapPreviewCornersToStill(editorCorners, page.previewWidth, page.previewHeight, pendingCapture.width, pendingCapture.height);
      reviewCorners = editorCorners.map(function (point) { return { x: point.x, y: point.y }; }); initialReviewCorners = reviewCorners.map(function (point) { return { x: point.x, y: point.y }; }); elements.reviewMode.value = page.scanMode; elements.reviewTitle.textContent = "Review page " + page.sequence;
      const displayBlob = reviewRotation ? await bitmapToBlob(pendingCapture) : page.originalImage;
      if (generation !== reviewGeneration || reviewPageId !== pageId) return;
      if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = URL.createObjectURL(displayBlob); elements.reviewImage.src = reviewUrl;
      if (elements.reviewImage.decode) await elements.reviewImage.decode(); else await new Promise(function (resolve, reject) { elements.reviewImage.onload = resolve; elements.reviewImage.onerror = reject; });
      if (generation !== reviewGeneration || reviewPageId !== pageId) return;
      setScreen("review"); drawReview();
    } catch (error) { if (generation === reviewGeneration) showToast("Could not open this page for review."); }
  }

  function cleanupReview() {
    reviewGeneration += 1;
    if (pendingCapture && pendingCapture.close) pendingCapture.close(); pendingCapture = undefined;
    elements.reviewImage.removeAttribute("src");
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = undefined;
    if (processedReviewUrl) URL.revokeObjectURL(processedReviewUrl); processedReviewUrl = undefined;
    showingProcessedReview = false; elements.reviewCanvas.hidden = false; elements.compare.textContent = "Preview processed";
  }

  async function keepReview() {
    if (!pendingCapture || !reviewPageId) return;
    reviewGeneration += 1;
    const page = findPage(reviewPageId); if (!page) return;
    page.finalCorners = reviewPoints().map(function (point) { return { x: point.x, y: point.y }; }); page.cornersAreStill = true; page.rotation = reviewRotation; page.scanMode = elements.reviewMode.value; page.cropStatus = "accepted"; page.cropManuallyAccepted = true; page.qualityWarnings = []; page.status = "captured"; page.revision += 1; page.processingAttempts = 0; page.processedImage = null;
    processingQueue = processingQueue.filter(function (job) { return job.pageId !== page.id; }); processingQueue.push({ pageId: page.id, revision: page.revision, generation: sessionGeneration });
    cleanupReview();
    renderFilmstrip(); pumpProcessingQueue();
    const wasFlaggedReview = reviewReturnPhase === "flagged-review"; reviewPageId = null;
    if (wasFlaggedReview) openNextFlaggedPage(); else setScreen(stream ? "scanner" : "welcome");
    stableCorners = []; readySince = 0;
  }

  function retakeReview() {
    reviewGeneration += 1;
    if (reviewPageId) removePageById(reviewPageId);
    cleanupReview();
    reviewPageId = null; finishing = false; if (stream) setScreen("scanner"); else startCamera();
    stableCorners = []; readySince = 0;
  }

  function deleteReviewedPage() {
    if (!reviewPageId) return; const returnPhase = reviewReturnPhase; removePageById(reviewPageId); reviewPageId = null; cleanupReview();
    if (returnPhase === "flagged-review") openNextFlaggedPage(); else setScreen(stream ? "scanner" : "welcome");
  }

  function removePageById(pageId) {
    for (let groupIndex = 0; groupIndex < documentGroups.length; groupIndex += 1) {
      const index = documentGroups[groupIndex].findIndex(function (page) { return page.id === pageId; });
      if (index >= 0) { const page = documentGroups[groupIndex][index]; page.cancelled = true; disposePage(page); documentGroups[groupIndex].splice(index, 1); processingQueue = processingQueue.filter(function (job) { return job.pageId !== pageId; }); updateControls(); return true; }
    }
    return false;
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
    pendingCapture = await rotateBitmapClockwise(pendingCapture); reviewRotation = (reviewRotation + 1) % 4;
    reviewCorners = ScannerGeometry.orderCorners(reviewPoints().map(function (point) { return { x: 1 - point.y, y: point.x }; }));
    initialReviewCorners = ScannerGeometry.orderCorners(initialReviewCorners.map(function (point) { return { x: 1 - point.y, y: point.x }; }));
    if (reviewUrl) URL.revokeObjectURL(reviewUrl); reviewUrl = URL.createObjectURL(await bitmapToBlob(pendingCapture)); elements.reviewImage.src = reviewUrl;
    if (elements.reviewImage.decode) await elements.reviewImage.decode();
    showOriginalReview();
    drawReview();
  }

  function manualCapture() {
    captureCurrentPage(lastReliableCorners || currentCorners, "manual");
  }

  async function openCameraFile(file) {
    if (!file) return;
    try {
      const corners = [{ x: .03, y: .03 }, { x: .97, y: .03 }, { x: .97, y: .97 }, { x: .03, y: .97 }];
      const page = { id: makeId(), revision: 1, sequence: pageSequence += 1, createdAt: performance.now(), originalImage: file, detectedCorners: null, refinedCorners: null, finalCorners: corners, cornersAreStill: true, detectionConfidence: 0, refinementConfidence: 0, cropStatus: "needs-crop", qualityWarnings: ["Imported image needs crop review"], processedImage: null, processedMimeType: null, processedWidth: 0, processedHeight: 0, rotation: 0, scanMode: elements.scanMode.value, status: "captured", fingerprint: null, previewWidth: 0, previewHeight: 0, sourceWidth: 0, sourceHeight: 0, thumbnailBlob: null, thumbnailUrl: null, processingAttempts: 0, timings: { stillCaptureMs: 0 }, cancelled: false };
      currentGroup().push(page); processingQueue.push({ pageId: page.id, revision: page.revision, generation: sessionGeneration }); updateControls(); pumpProcessingQueue(); elements.cameraFileInput.value = "";
    } catch (error) { showToast("Could not open that camera image."); }
  }

  function undoPage() {
    for (let index = documentGroups.length - 1; index >= 0; index -= 1) {
      if (documentGroups[index].length) {
        const page = documentGroups[index].pop(); page.cancelled = true; disposePage(page); processingQueue = processingQueue.filter(function (job) { return job.pageId !== page.id; });
        if (documentGroups[index].length === 0 && index === documentGroups.length - 1 && documentGroups.length > 1) documentGroups.pop();
        requiresPageChange = false;
        stableCorners = [];
        updateControls();
        showToast("Last page removed."); elements.captureFeedback.hidden = true;
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

  function flaggedPages() {
    return allPages().filter(function (page) { return page.cropStatus !== "accepted" || page.status === "error"; }).sort(function (one, two) { const rank = { "needs-crop": 0, "check": 1, "accepted": 2 }; return rank[one.cropStatus] - rank[two.cropStatus]; });
  }

  function renderFlaggedPages() {
    const pages = flaggedPages(); elements.flaggedList.replaceChildren();
    pages.forEach(function (page) { const button = document.createElement("button"); button.type = "button"; button.className = "flagged-page"; button.dataset.pageId = page.id; if (page.thumbnailUrl) { const image = document.createElement("img"); image.src = page.thumbnailUrl; image.alt = ""; button.append(image); } const reason = document.createElement("span"); reason.textContent = page.cropStatus === "needs-crop" ? "Needs crop" : "Check crop"; if (page.qualityWarnings.length) reason.textContent += ": " + page.qualityWarnings[0]; button.append(reason); elements.flaggedList.append(button); });
  }

  function requestFinish() {
    if (!totalPages()) return; finishing = true; closeMenu(); elements.manualCapture.disabled = true; elements.newDocument.disabled = true; elements.status.textContent = "Finishing page processing..."; maybeCompleteFinish();
  }

  function maybeCompleteFinish() {
    if (!finishing || isCapturing || processingBusy || processingQueue.length || allPages().some(function (page) { return page.status === "captured" || page.status === "processing"; })) return;
    stopCamera();
    if (flaggedPages().length) { renderFlaggedPages(); setScreen("flagged"); }
    else generatePdfs();
  }

  function startFlaggedReview() {
    flaggedReviewIds = flaggedPages().map(function (page) { return page.id; }); openNextFlaggedPage();
  }

  function openNextFlaggedPage() {
    while (flaggedReviewIds.length && !findPage(flaggedReviewIds[0])) flaggedReviewIds.shift();
    if (!flaggedReviewIds.length) { setScreen("flagged"); maybeCompleteFinish(); return; }
    const pageId = flaggedReviewIds.shift(); openPageEditor(pageId, "flagged-review");
  }

  function continueAnyway() { finishing = true; generatePdfs(); }

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
          const source = await pdfImageForPage(scan); const bytes = await source.blob.arrayBuffer();
          const image = source.mimeType === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
          const imageWidth = scan.processedWidth || scan.sourceWidth || image.width; const imageHeight = scan.processedHeight || scan.sourceHeight || image.height; const landscape = imageWidth > imageHeight; const pageWidth = landscape ? 1008 : 612; const pageHeight = landscape ? 612 : 1008;
          const page = pdf.addPage([pageWidth, pageHeight]); const scale = Math.min(pageWidth / image.width, pageHeight / image.height); const width = image.width * scale; const height = image.height * scale;
          page.drawImage(image, { x: (pageWidth - width) / 2, y: (pageHeight - height) / 2, width: width, height: height });
        }
        const bytes = await pdf.save({ useObjectStreams: true });
        const fileName = "scan-document-" + String(groupIndex + 1).padStart(2, "0") + ".pdf";
        const blob = new Blob([bytes], { type: "application/pdf" });
        generatedFiles.push({
          name: fileName,
          pages: groups[groupIndex].length,
          modes: groups[groupIndex].map(function (scan) { return scan.scanMode; }),
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
      finishing = false;
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
  elements.finish.addEventListener("click", requestFinish);
  elements.finishFiles.addEventListener("click", requestFinish);
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
  elements.deletePage.addEventListener("click", deleteReviewedPage);
  elements.compare.addEventListener("click", toggleProcessedReview);
  elements.reviewMode.addEventListener("change", function () {
    if (showingProcessedReview) { showOriginalReview(); drawReview(); }
  });
  elements.reviewCanvas.addEventListener("pointerdown", beginCornerDrag);
  elements.reviewCanvas.addEventListener("pointermove", moveCorner);
  elements.reviewCanvas.addEventListener("pointerup", endCornerDrag);
  elements.reviewCanvas.addEventListener("pointercancel", endCornerDrag);
  elements.filmstrip.addEventListener("click", function (event) { const pageButton = event.target.closest("[data-page-id]"); if (pageButton) openPageEditor(pageButton.dataset.pageId, "scanner"); });
  elements.captureFeedbackUndo.addEventListener("click", undoPage);
  elements.flaggedList.addEventListener("click", function (event) { const pageButton = event.target.closest("[data-page-id]"); if (pageButton) openPageEditor(pageButton.dataset.pageId, "flagged-review"); });
  elements.reviewFlagged.addEventListener("click", startFlaggedReview);
  elements.continueAnyway.addEventListener("click", continueAnyway);
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
  function startDetectorWorker() {
    if (typeof Worker !== "function") return;
    const worker = new Worker("detector-worker.js"); detectorWorker = worker;
    worker.onmessage = function (event) {
      if (event.data.type === "result") handleDetection(event.data);
      if (event.data.type === "error") {
        detectorBusy = false;
        elements.status.textContent = "Use the capture button if page detection is unavailable.";
        showToast("Detector error: " + event.data.message);
      }
    };
    function handleDetectorCrash() {
      if (detectorWorker !== worker) return;
      worker.terminate(); detectorWorker = null; detectorBusy = false;
      if (detectorWorkerRestarts < 1) {
        detectorWorkerRestarts += 1; startDetectorWorker();
        if (appPhase === "scanner" && stream) startDetection();
        return;
      }
      detectorBusy = false;
      elements.status.textContent = "Use the capture button if page detection is unavailable.";
      showToast("Automatic detection is unavailable. Manual capture is still ready.");
    }
    worker.onerror = handleDetectorCrash;
    worker.onmessageerror = handleDetectorCrash;
  }

  function startProcessingWorker() {
    if (typeof Worker !== "function") return;
    const worker = new Worker("processing-worker.js"); processingWorker = worker; processingWorkerReady = false;
    worker.onmessage = function (event) {
      if (event.data.type === "ready") { clearTimeout(processingReadyTimer); processingWorkerReady = true; pumpProcessingQueue(); }
      if (event.data.type === "processed") applyProcessingResult(event.data);
      if (event.data.type === "error") {
        const job = processingJobMatches(event.data) ? activeProcessingJob : null; const page = job && findPage(job.pageId);
        if (job) handleProcessingFailure(page, job, new Error(event.data.message));
      }
    };
    function handleProcessingCrash() {
      if (processingWorker !== worker) return;
      clearTimeout(processingReadyTimer); worker.terminate(); processingWorker = null; processingWorkerReady = false;
      if (processingWorkerRestarts < 1) {
        processingWorkerRestarts += 1;
        const job = activeProcessingJob; const page = job && findPage(job.pageId);
        startProcessingWorker();
        if (job) handleProcessingFailure(page, job, new Error("Processing worker restarted"));
        return;
      }
      markProcessingUnavailable();
      showToast("Background processing is unavailable. Original pages can still be exported.");
    }
    worker.onerror = handleProcessingCrash;
    worker.onmessageerror = handleProcessingCrash;
    processingReadyTimer = setTimeout(handleProcessingCrash, 15000);
  }
  startDetectorWorker();
  startProcessingWorker();
  updateControls();
  setTimeout(startCamera, 0);
})();
