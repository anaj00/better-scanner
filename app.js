/* global cv, PDFLib, JSZip, ScannerGeometry */
(function () {
  "use strict";

  const PROCESSING_WIDTH = 720;
  const AUTO_CAPTURE_STABLE_FRAMES = 2;
  const DETECTION_INTERVAL = 100;
  const PAGE_REMOVED_DELAY = 650;
  const PAGE_CHANGE_DELAY = 900;
  const CAMERA_FOCUS_SETTLE_MS = 700;
  const PAGE_FOCUS_SETTLE_MS = 350;

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
  let stableSince = 0;
  let currentCorners;
  let documentGroups = [[]];
  let generatedFiles = [];
  let toastTimer;
  let torchEnabled = false;
  let pendingCapture;
  let reviewCorners;
  let initialReviewCorners;
  let activeReviewCorner = -1;
  let appPhase = "welcome";
  let reviewUrl;
  let processedReviewUrl;
  let showingProcessedReview = false;
  let cameraSessionId = 0;
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
  let feedbackTimer;
  let processingWorker = null;
  let processingWorkerRestarts = 0;
  let processingReadyTimer;
  let stillImageCapture = null;
  let cameraReadyAt = 0;

  const processCanvas = document.createElement("canvas");
  const sourceCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");
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
    stillImageCapture = null;
    cameraReadyAt = 0;
    stableCorners = []; stableSince = 0;
    currentCorners = undefined;
    requiresPageChange = false;
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
    documentGroups = [[]]; processingQueue = []; processingBusy = false; pageSequence = 0; reviewPageId = null; flaggedReviewIds = []; finishing = false;
    generatedFiles.forEach(function (file) { URL.revokeObjectURL(file.url); });
    generatedFiles = [];
    stableCorners = []; stableSince = 0;
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
    elements.manualCapture.disabled = true;
    setScreen("scanner");
    closeMenu();
    elements.status.textContent = "Opening camera...";
    let sessionId;
    try {
      stopCamera();
      sessionId = cameraSessionId;
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
      if (sessionId !== cameraSessionId) return;
      const track = stream.getVideoTracks()[0]; const capabilities = track && track.getCapabilities ? track.getCapabilities() : {};
      if (track && track.applyConstraints && Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes("continuous")) {
        try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (error) { /* Continuous autofocus remains the browser default. */ }
      }
      if (window.ImageCapture && track) { try { stillImageCapture = new ImageCapture(track); } catch (error) { stillImageCapture = null; } }
      cameraReadyAt = performance.now() + CAMERA_FOCUS_SETTLE_MS;
      updateFlashControl();
      elements.manualCapture.disabled = true;
      elements.status.textContent = "Starting page detection...";
      waitForOpenCv().then(function () {
        if (!stream || sessionId !== cameraSessionId) return;
        const focusDelay = Math.max(0, cameraReadyAt - performance.now());
        setTimeout(function () { if (stream && sessionId === cameraSessionId) elements.manualCapture.disabled = false; }, focusDelay);
        elements.status.textContent = focusDelay ? "Focusing camera..." : "Finding a page...";
        startDetection();
      }).catch(function () {
        if (sessionId !== cameraSessionId) return;
        elements.status.textContent = "Camera is ready, but page detection could not load.";
        showToast("The camera opened, but page detection did not load. Check your connection and reload.");
      });
    } catch (error) {
      if (sessionId !== cameraSessionId) return;
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

  function normalizedPointsFromMat(mat, canvas, floating) {
    const points = [];
    for (let index = 0; index < 4; index += 1) {
      const point = floating ? mat.floatPtr(index, 0) : mat.intPtr(index, 0);
      points.push({ x: point[0] / canvas.width, y: point[1] / canvas.height });
    }
    return ScannerGeometry.orderCorners(points);
  }

  function rectangleScore(points) {
    if (!points) return -Infinity;
    const sides = [distance(points[0], points[1]), distance(points[1], points[2]), distance(points[2], points[3]), distance(points[3], points[0])];
    if (Math.min.apply(null, sides) < .16 || Math.max.apply(null, sides) / Math.min.apply(null, sides) > 5) return -Infinity;
    const area = Math.abs(ScannerGeometry.signedArea(points));
    if (area < .07 || area > .96) return -Infinity;
    const center = points.reduce(function (sum, point) { return { x: sum.x + point.x / 4, y: sum.y + point.y / 4 }; }, { x: 0, y: 0 });
    return area * (1 - Math.min(.35, Math.hypot(center.x - .5, center.y - .5) * .35));
  }

  function bestRectangleFromMask(mask, canvas) {
    const contours = new cv.MatVector(); const hierarchy = new cv.Mat(); let best; let bestScore = -Infinity;
    try {
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index); let approximation; let box;
        try {
          const contourArea = Math.abs(cv.contourArea(contour));
          if (contourArea >= canvas.width * canvas.height * .055) {
            const perimeter = cv.arcLength(contour, true); approximation = new cv.Mat(); cv.approxPolyDP(contour, approximation, .018 * perimeter, true); let points; let score = -Infinity;
            if (approximation.rows === 4 && cv.isContourConvex(approximation)) { points = normalizedPointsFromMat(approximation, canvas, false); score = rectangleScore(points) + .15; }
            else {
              const rotatedRect = cv.minAreaRect(contour); const rotatedArea = rotatedRect.size.width * rotatedRect.size.height; const rectangularity = rotatedArea ? contourArea / rotatedArea : 0;
              if (approximation.rows >= 3 && approximation.rows <= 6 && rectangularity > .32) { box = cv.boxPoints(rotatedRect); points = normalizedPointsFromMat(box, canvas, true); score = rectangleScore(points) * rectangularity; }
            }
            if (score > bestScore) { best = points; bestScore = score; }
          }
        } finally { if (box) box.delete(); if (approximation) approximation.delete(); contour.delete(); }
      }
      return best;
    } finally { contours.delete(); hierarchy.delete(); }
  }

  function quadrilateralFromCanvas(canvas) {
    const source = cv.imread(canvas); const gray = new cv.Mat(); const blurred = new cv.Mat(); const edges = new cv.Mat(); const connectedEdges = new cv.Mat(); const threshold = new cv.Mat(); const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    try {
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0); cv.Canny(blurred, edges, 20, 90); cv.morphologyEx(edges, connectedEdges, cv.MORPH_CLOSE, kernel); cv.dilate(connectedEdges, connectedEdges, kernel);
      let rectangle = bestRectangleFromMask(connectedEdges, canvas); if (rectangle) return rectangle;
      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel); rectangle = bestRectangleFromMask(threshold, canvas); if (rectangle) return rectangle;
      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU); cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel); return bestRectangleFromMask(threshold, canvas);
    } finally { source.delete(); gray.delete(); blurred.delete(); edges.delete(); connectedEdges.delete(); threshold.delete(); kernel.delete(); }
  }

  function processFrame() {
    if (!opencvReady || appPhase !== "scanner" || !stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || isCapturing) return;
    const videoWidth = elements.video.videoWidth;
    const videoHeight = elements.video.videoHeight;
    if (!videoWidth || !videoHeight) return;
    const scale = Math.min(1, PROCESSING_WIDTH / videoWidth);
    processCanvas.width = Math.round(videoWidth * scale); processCanvas.height = Math.round(videoHeight * scale); processContext = processCanvas.getContext("2d", { willReadFrequently: true });
    processContext.drawImage(elements.video, 0, 0, processCanvas.width, processCanvas.height);
    let corners;
    try { corners = quadrilateralFromCanvas(processCanvas); }
    catch (error) {
      elements.status.textContent = "Use the capture button if page detection is unavailable.";
      return;
    }
    currentCorners = corners;
    if (!corners) {
      currentCorners = pageGuideCorners();
      drawOutline(pageGuideCorners(), false, true);
      stableCorners = [];
      stableSince = 0;
      if (requiresPageChange && Date.now() - lastPageSeenAt > PAGE_REMOVED_DELAY) { requiresPageChange = false; elements.manualCapture.disabled = false; elements.status.textContent = "Ready for the next page."; }
      else if (!requiresPageChange) {
        elements.status.textContent = "Finding page edges. Align it to the dashed " + guideLabel() + " guide.";
      }
      return;
    }
    lastPageSeenAt = Date.now();
    if (requiresPageChange) {
      stableSince = 0; elements.manualCapture.disabled = true; drawOutline(corners, false); elements.status.textContent = "Move the page away, then show the next one.";
      return;
    }
    stableCorners.push(corners);
    if (stableCorners.length > AUTO_CAPTURE_STABLE_FRAMES) stableCorners.shift();
    const stable = stableCorners.length === AUTO_CAPTURE_STABLE_FRAMES && averageCornerMovement(stableCorners) < .008; const cameraFocused = performance.now() >= cameraReadyAt;
    if (stable && !stableSince) stableSince = performance.now(); else if (!stable) stableSince = 0;
    const pageFocused = stable && performance.now() - stableSince >= PAGE_FOCUS_SETTLE_MS; const captureReady = cameraFocused && pageFocused;
    drawOutline(corners, captureReady);
    elements.status.textContent = !cameraFocused ? "Focusing camera..." : stable && !pageFocused ? "Focusing page..." : captureReady ? (elements.autoCapture.checked ? "Page ready. Capturing..." : "Page ready. Tap capture.") : "Hold steady to scan automatically...";
    if (captureReady && elements.autoCapture.checked) captureCurrentPage(corners, "auto");
  }

  function distance(one, two) {
    return Math.hypot(one.x - two.x, one.y - two.y);
  }

  function outputDimensions(corners, sourceWidth, sourceHeight) {
    const points = corners.map(function (point) { return { x: point.x * sourceWidth, y: point.y * sourceHeight }; });
    const width = Math.max(distance(points[0], points[1]), distance(points[3], points[2])); const height = Math.max(distance(points[0], points[3]), distance(points[1], points[2])); const scale = Math.min(1, 2400 / Math.max(width, height), Math.sqrt(5000000 / (width * height)));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) { canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("Image encoding failed")); }, type, quality); });
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

  function showCaptureFeedback(page) {
    clearTimeout(feedbackTimer); elements.captureFeedbackText.textContent = "Page " + totalPages() + " captured"; elements.captureFeedback.hidden = false;
    feedbackTimer = setTimeout(function () { elements.captureFeedback.hidden = true; }, 2800);
  }

  function showShutterFeedback() {
    elements.flash.classList.remove("active"); void elements.flash.offsetWidth; elements.flash.classList.add("active");
    if (navigator.vibrate) navigator.vibrate(35);
  }

  async function captureSourceFrame(corners) {
    const previewWidth = elements.video.videoWidth; const previewHeight = elements.video.videoHeight; const track = stream && stream.getVideoTracks()[0];
    showShutterFeedback();
    if (!stillImageCapture && window.ImageCapture && track) { try { stillImageCapture = new ImageCapture(track); } catch (error) { stillImageCapture = null; } }
    if (stillImageCapture) {
      try {
        const blob = await stillImageCapture.takePhoto(); const source = await decodeBlobToSource(blob);
        try {
          const mappedCorners = mapPreviewCornersToStill(corners, previewWidth, previewHeight, source.width, source.height); const scale = Math.min(1, 4096 / Math.max(source.width, source.height), Math.sqrt(12000000 / (source.width * source.height)));
          sourceCanvas.width = Math.round(source.width * scale); sourceCanvas.height = Math.round(source.height * scale); sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, sourceCanvas.width, sourceCanvas.height);
          return { corners: mappedCorners, width: sourceCanvas.width, height: sourceCanvas.height };
        } finally { if (source.close) source.close(); }
      } catch (error) { stillImageCapture = null; /* Use the current video frame below. */ }
    }
    sourceCanvas.width = previewWidth; sourceCanvas.height = previewHeight; sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(elements.video, 0, 0, previewWidth, previewHeight);
    return { corners: corners, width: previewWidth, height: previewHeight };
  }

  async function captureCurrentPage(corners, source) {
    if (isCapturing || finishing || totalPages() >= 50) return;
    isCapturing = true;
    elements.status.textContent = "Processing page...";
    const started = performance.now(); const captureSessionId = cameraSessionId; const targetGroup = currentGroup(); const mats = [];
    const chosenCorners = corners && ScannerGeometry.validateQuad(corners) ? corners.map(function (point) { return { x: point.x, y: point.y }; }) : pageGuideCorners();
    try {
      const captured = await captureSourceFrame(chosenCorners); if (captureSessionId !== cameraSessionId) return;
      const dimensions = outputDimensions(captured.corners, captured.width, captured.height); const input = cv.imread(sourceCanvas); const warped = new cv.Mat(); mats.push(input, warped);
      const sourcePoints = []; captured.corners.forEach(function (point) { sourcePoints.push(point.x * captured.width, point.y * captured.height); });
      const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints); const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,dimensions.width-1,0,dimensions.width-1,dimensions.height-1,0,dimensions.height-1]); const transform = cv.getPerspectiveTransform(sourceMat, destinationMat); mats.push(sourceMat, destinationMat, transform);
      cv.warpPerspective(input, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      const originalCanvas = document.createElement("canvas"); originalCanvas.width = dimensions.width; originalCanvas.height = dimensions.height; cv.imshow(originalCanvas, warped); const originalBlob = await canvasToBlob(originalCanvas, "image/jpeg", .95);
      const mode = elements.scanMode.value; const mimeType = "image/jpeg"; let blob;
      outputCanvas.width = dimensions.width; outputCanvas.height = dimensions.height;
      if (mode === "original") { outputCanvas.getContext("2d").drawImage(originalCanvas, 0, 0); blob = originalBlob; }
      else { const output = mode === "grayscale" ? processGrayscale(warped, mats) : processBlackAndWhite(warped, mats); cv.imshow(outputCanvas, output); blob = await canvasToBlob(outputCanvas, mimeType, .9); }
      if (captureSessionId !== cameraSessionId) return;
      const thumbnailCanvas = document.createElement("canvas"); const thumbnailScale = 200 / Math.max(dimensions.width, dimensions.height); thumbnailCanvas.width = Math.round(dimensions.width * thumbnailScale); thumbnailCanvas.height = Math.round(dimensions.height * thumbnailScale); thumbnailCanvas.getContext("2d").drawImage(outputCanvas, 0, 0, thumbnailCanvas.width, thumbnailCanvas.height); const thumbnailBlob = await canvasToBlob(thumbnailCanvas, "image/jpeg", .72);
      if (captureSessionId !== cameraSessionId) return;
      const fullImage = [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
      const page = { id: makeId(), revision: 1, sequence: pageSequence += 1, createdAt: started, originalImage: originalBlob, detectedCorners: fullImage, refinedCorners: fullImage, finalCorners: fullImage, cornersAreStill: true, detectionConfidence: 1, refinementConfidence: 1, cropStatus: "accepted", qualityWarnings: [], processedImage: blob, processedMimeType: mimeType, processedWidth: dimensions.width, processedHeight: dimensions.height, rotation: 0, scanMode: mode, status: "ready", previewWidth: dimensions.width, previewHeight: dimensions.height, sourceWidth: dimensions.width, sourceHeight: dimensions.height, thumbnailBlob: thumbnailBlob, thumbnailUrl: URL.createObjectURL(thumbnailBlob), processingAttempts: 0, timings: { totalReadyMs: performance.now() - started }, cancelled: false };
      targetGroup.push(page); requiresPageChange = true; lastPageSeenAt = Date.now(); stableCorners = []; stableSince = 0;
      elements.manualCapture.disabled = true; updateControls(); showCaptureFeedback(page); elements.status.textContent = "Move the page away, then show the next one.";
      setTimeout(function () { if (requiresPageChange) elements.status.textContent = "Move the page away, then show the next one."; }, PAGE_CHANGE_DELAY);
    } catch (error) {
      showToast("Could not process this page. Try the capture button again."); elements.status.textContent = "Ready to try again.";
    } finally {
      mats.reverse().forEach(function (mat) { if (mat) mat.delete(); }); sourceCanvas.width = 1; sourceCanvas.height = 1; outputCanvas.width = 1; outputCanvas.height = 1; isCapturing = false; if (finishing) maybeCompleteFinish();
    }
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

  function processGrayscale(warped, mats) {
    const gray = new cv.Mat(); mats.push(gray); cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY); return gray;
  }

  function processBlackAndWhite(warped, mats) {
    const gray = new cv.Mat(); const background = new cv.Mat(); const normalized = new cv.Mat(); const denoised = new cv.Mat(); const binary = new cv.Mat(); const output = new cv.Mat(); mats.push(gray, background, normalized, denoised, binary, output);
    const backgroundSize = Math.max(31, Math.min(81, Math.round(Math.min(warped.rows, warped.cols) / 24) | 1)); cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY); cv.blur(gray, background, new cv.Size(backgroundSize, backgroundSize)); cv.divide(gray, background, normalized, 250); cv.medianBlur(normalized, denoised, 3);
    let blockSize = Math.round(Math.min(warped.rows, warped.cols) / 18) | 1; blockSize = Math.max(61, Math.min(121, blockSize)); cv.adaptiveThreshold(denoised, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 15); cv.addWeighted(denoised, .25, binary, .75, 0, output); return output;
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
      elements.reviewMode.disabled = Boolean(page.cameraCapture);
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
    stableCorners = []; stableSince = 0;
  }

  function retakeReview() {
    reviewGeneration += 1;
    if (reviewPageId) removePageById(reviewPageId);
    cleanupReview();
    reviewPageId = null; finishing = false; requiresPageChange = false; if (stream) { elements.manualCapture.disabled = false; setScreen("scanner"); } else startCamera();
    stableCorners = []; stableSince = 0;
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
      const mode = elements.reviewMode.value; const output = mode === "original" ? processOriginal(warped, mats) : mode === "grayscale" ? processGrayscale(warped, mats) : processBlackAndWhite(warped, mats);
      previewOutput.width = dimensions.width; previewOutput.height = dimensions.height; cv.imshow(previewOutput, output);
      const blob = await canvasToBlob(previewOutput, "image/jpeg", .88);
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
    if (requiresPageChange) { showToast("Move the current page away before capturing the next one."); return; }
    if (performance.now() < cameraReadyAt) { showToast("Give the camera a moment to focus."); return; }
    if (!currentCorners) showToast("Using the Legal guide. Keep the page inside its dashed border.");
    captureCurrentPage(currentCorners || pageGuideCorners(), "manual");
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
        if (stream) elements.manualCapture.disabled = false;
        stableCorners = []; stableSince = 0;
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
    fallback.target = "_blank";
    fallback.rel = "noopener";
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
  startProcessingWorker();
  updateControls();
  setTimeout(startCamera, 0);
})();
