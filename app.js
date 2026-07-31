/* global cv, PDFLib, JSZip */
(function () {
  "use strict";

  const PROCESSING_WIDTH = 480;
  const AUTO_CAPTURE_STABLE_FRAMES = 2;
  const DETECTION_INTERVAL = 180;
  const PAGE_REMOVED_DELAY = 350;
  const PAGE_CHANGE_DELAY = 450;
  const DPI = 200;

  const elements = {
    appHeader: document.querySelector("#app-header"),
    welcome: document.querySelector("#welcome-screen"),
    scanner: document.querySelector("#scanner-screen"),
    results: document.querySelector("#results-screen"),
    start: document.querySelector("#start-button"),
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
    secureNote: document.querySelector("#secure-context-note")
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

  const processCanvas = document.createElement("canvas");
  const sourceCanvas = document.createElement("canvas");
  const outputCanvas = document.createElement("canvas");

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    toastTimer = setTimeout(function () { elements.toast.classList.remove("visible"); }, 3200);
  }

  function setScreen(screen) {
    elements.welcome.hidden = screen !== "welcome";
    elements.scanner.hidden = screen !== "scanner";
    elements.results.hidden = screen !== "results";
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
    renderMenuDocuments();
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
    clearTimeout(detectionTimer);
    detectionTimer = undefined;
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      stream = undefined;
    }
    elements.video.srcObject = null;
    torchEnabled = false;
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
    stopCamera();
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
      const constraints = {
        audio: false,
        video: {
          facingMode: { ideal: cameraFacing },
          width: { ideal: 1920 },
          height: { ideal: 1920 }
        }
      };
      stream = await navigator.mediaDevices.getUserMedia(constraints);
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

  function orderCorners(points) {
    const bySum = points.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    const topLeft = bySum[0];
    const bottomRight = bySum[3];
    const remaining = points.filter(function (point) { return point !== topLeft && point !== bottomRight; });
    const topRight = remaining[0].x > remaining[1].x ? remaining[0] : remaining[1];
    const bottomLeft = remaining[0] === topRight ? remaining[1] : remaining[0];
    return [topLeft, topRight, bottomRight, bottomLeft];
  }

  function normalizedPointsFromMat(mat, canvas, isFloat) {
    const points = [];
    for (let index = 0; index < 4; index += 1) {
      const point = isFloat ? mat.floatPtr(index, 0) : mat.intPtr(index, 0);
      points.push({
        x: point[0] / canvas.width,
        y: point[1] / canvas.height
      });
    }
    return orderCorners(points);
  }

  function rectangleScore(points, canvas) {
    const scaledDistance = function (one, two) {
      return Math.hypot((one.x - two.x) * canvas.width, (one.y - two.y) * canvas.height);
    };
    const top = scaledDistance(points[0], points[1]);
    const right = scaledDistance(points[1], points[2]);
    const bottom = scaledDistance(points[2], points[3]);
    const left = scaledDistance(points[3], points[0]);
    const shortestSide = Math.min(top, right, bottom, left);
    const longestSide = Math.max(top, right, bottom, left);
    if (shortestSide < Math.min(canvas.width, canvas.height) * .2 || longestSide / shortestSide > 2.5) return -Infinity;
    const pageRatio = Math.min((top + bottom) / 2, (left + right) / 2) / Math.max((top + bottom) / 2, (left + right) / 2);
    const expectedRatio = 8.5 / 14;
    if (Math.abs(pageRatio - expectedRatio) > .24) return -Infinity;
    let area = 0;
    let centerX = 0;
    let centerY = 0;
    points.forEach(function (point, index) {
      const next = points[(index + 1) % points.length];
      area += point.x * next.y - next.x * point.y;
      centerX += point.x;
      centerY += point.y;
    });
    area = Math.abs(area) / 2;
    if (area < .13 || area > .92) return -Infinity;
    const distanceFromCenter = Math.hypot(centerX / 4 - .5, centerY / 4 - .5);
    return area * (1 - Math.min(.35, distanceFromCenter * .35));
  }

  function bestRectangleFromMask(mask, canvas, retrievalMode, minimumCoverage) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    let best;
    let bestScore = -Infinity;
    try {
      cv.findContours(mask, contours, hierarchy, retrievalMode, cv.CHAIN_APPROX_SIMPLE);
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const contourArea = Math.abs(cv.contourArea(contour));
        if (contourArea >= canvas.width * canvas.height * minimumCoverage) {
          const perimeter = cv.arcLength(contour, true);
          const approximation = new cv.Mat();
          cv.approxPolyDP(contour, approximation, .018 * perimeter, true);
          let points;
          let score = -Infinity;
          if (approximation.rows === 4 && cv.isContourConvex(approximation)) {
            points = normalizedPointsFromMat(approximation, canvas, false);
            score = rectangleScore(points, canvas) + .15;
          } else {
            const rotatedRect = cv.minAreaRect(contour);
            const rotatedArea = rotatedRect.size.width * rotatedRect.size.height;
            const rectangularity = rotatedArea ? contourArea / rotatedArea : 0;
            // A page with one weak edge can still produce a 3-6 side outer contour.
            // Inner boxes are rejected by the page-size and Legal-aspect checks above.
            if (approximation.rows >= 3 && approximation.rows <= 6 && rectangularity > .32) {
              const box = cv.boxPoints(rotatedRect);
              points = normalizedPointsFromMat(box, canvas, true);
              box.delete();
              score = rectangleScore(points, canvas) * rectangularity;
            }
          }
          approximation.delete();
          if (score > bestScore) {
            best = points;
            bestScore = score;
          }
        }
        contour.delete();
      }
      return best;
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  function quadrilateralFromCanvas(canvas) {
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const connectedEdges = new cv.Mat();
    const threshold = new cv.Mat();
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      // Canny finds clear outer borders. Closing bridges small gaps without merging form fields.
      cv.Canny(blurred, edges, 20, 90);
      cv.morphologyEx(edges, connectedEdges, cv.MORPH_CLOSE, kernel);
      let rectangle = bestRectangleFromMask(connectedEdges, canvas, cv.RETR_EXTERNAL, .1);
      if (rectangle) return rectangle;

      // A light page on a darker table often has no continuous Canny border.
      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
      rectangle = bestRectangleFromMask(threshold, canvas, cv.RETR_EXTERNAL, .1);
      if (rectangle) return rectangle;

      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
      return bestRectangleFromMask(threshold, canvas, cv.RETR_EXTERNAL, .1);
    } finally {
      src.delete();
      gray.delete();
      blurred.delete();
      edges.delete();
      connectedEdges.delete();
      threshold.delete();
      kernel.delete();
    }
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
    if (!opencvReady || !stream || elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || isCapturing) return;
    const videoWidth = elements.video.videoWidth;
    const videoHeight = elements.video.videoHeight;
    if (!videoWidth || !videoHeight) return;
    const scale = Math.min(1, PROCESSING_WIDTH / videoWidth);
    processCanvas.width = Math.round(videoWidth * scale);
    processCanvas.height = Math.round(videoHeight * scale);
    processCanvas.getContext("2d", { willReadFrequently: true }).drawImage(elements.video, 0, 0, processCanvas.width, processCanvas.height);
    let corners;
    try {
      corners = quadrilateralFromCanvas(processCanvas);
    } catch (error) {
      elements.status.textContent = "Use the capture button if page detection is unavailable.";
      return;
    }
    currentCorners = corners;
    if (!corners) {
      currentCorners = pageGuideCorners();
      drawOutline(currentCorners, false, true);
      stableCorners = [];
      if (requiresPageChange && Date.now() - lastPageSeenAt > PAGE_REMOVED_DELAY) {
        requiresPageChange = false;
        elements.status.textContent = "Ready for the next page.";
      } else if (!requiresPageChange) {
        elements.status.textContent = "Finding page edges. Align it to the dashed " + guideLabel() + " guide.";
      }
      return;
    }
    lastPageSeenAt = Date.now();
    stableCorners.push(corners);
    if (stableCorners.length > AUTO_CAPTURE_STABLE_FRAMES) stableCorners.shift();
    const stable = stableCorners.length === AUTO_CAPTURE_STABLE_FRAMES && averageCornerMovement(stableCorners) < .005;
    drawOutline(corners, stable && !requiresPageChange);
    if (requiresPageChange) {
      elements.status.textContent = "Move the page away, then show the next one.";
      return;
    }
    elements.status.textContent = stable ? "Page ready. Capturing..." : "Hold steady to scan automatically...";
    if (stable) capturePage(corners);
  }

  function distance(one, two) {
    return Math.hypot(one.x - two.x, one.y - two.y);
  }

  function outputDimensions(corners, sourceWidth, sourceHeight) {
    const points = corners.map(function (point) { return { x: point.x * sourceWidth, y: point.y * sourceHeight }; });
    const top = distance(points[0], points[1]);
    const bottom = distance(points[3], points[2]);
    const left = distance(points[0], points[3]);
    const right = distance(points[1], points[2]);
    const ratio = Math.min(top, bottom) / Math.max(left, right);
    const portraitRatio = ratio > 1 ? 1 / ratio : ratio;
    const selected = elements.pageSize.value;
    let paper = selected;
    if (selected === "auto") {
      const a4Difference = Math.abs(portraitRatio - (210 / 297));
      const letterDifference = Math.abs(portraitRatio - (8.5 / 11));
      paper = Math.min(a4Difference, letterDifference) < .055 ? (a4Difference < letterDifference ? "a4" : "letter") : "custom";
    }
    let width;
    let height;
    if (paper === "a4") { width = 1654; height = 2339; }
    else if (paper === "legal") { width = 1700; height = 2800; }
    else if (paper === "letter") { width = 1700; height = 2200; }
    else {
      if (ratio > 1) {
        width = 2200;
        height = Math.round(Math.max(600, width / ratio));
      } else {
        height = 2200;
        width = Math.round(Math.max(600, height * ratio));
      }
      return { width: width, height: height };
    }
    if (ratio > 1) return { width: height, height: width };
    return { width: width, height: height };
  }

  function canvasToBlob(canvas) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
  }

  async function capturePage(corners) {
    if (isCapturing) return;
    isCapturing = true;
    elements.status.textContent = "Processing page...";
    try {
      const videoWidth = elements.video.videoWidth;
      const videoHeight = elements.video.videoHeight;
      sourceCanvas.width = videoWidth;
      sourceCanvas.height = videoHeight;
      sourceCanvas.getContext("2d", { willReadFrequently: true }).drawImage(elements.video, 0, 0, videoWidth, videoHeight);
      const dimensions = outputDimensions(corners, videoWidth, videoHeight);
      const source = cv.imread(sourceCanvas);
      const warped = new cv.Mat();
      const gray = new cv.Mat();
      const background = new cv.Mat();
      const normalized = new cv.Mat();
      const denoised = new cv.Mat();
      const blackAndWhite = new cv.Mat();
      const cleaned = new cv.Mat();
      const sourcePoints = [];
      corners.forEach(function (point) { sourcePoints.push(point.x * videoWidth, point.y * videoHeight); });
      const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints);
      const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dimensions.width - 1, 0, dimensions.width - 1, dimensions.height - 1, 0, dimensions.height - 1]);
      const transform = cv.getPerspectiveTransform(sourceMat, destinationMat);
      cv.warpPerspective(source, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
      if (elements.scanMode.value === "black-and-white") {
        cv.GaussianBlur(gray, background, new cv.Size(0, 0), 25);
        cv.divide(gray, background, normalized, 255);
        cv.GaussianBlur(normalized, denoised, new cv.Size(3, 3), 0);
        cv.threshold(denoised, blackAndWhite, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        cv.medianBlur(blackAndWhite, cleaned, 3);
      }
      outputCanvas.width = dimensions.width;
      outputCanvas.height = dimensions.height;
      const output = elements.scanMode.value === "color" ? warped : (elements.scanMode.value === "grayscale" ? gray : cleaned);
      cv.imshow(outputCanvas, output);
      const blob = await canvasToBlob(outputCanvas);
      source.delete(); warped.delete(); gray.delete(); background.delete(); normalized.delete(); denoised.delete(); blackAndWhite.delete(); cleaned.delete(); sourceMat.delete(); destinationMat.delete(); transform.delete();
      if (!blob) throw new Error("Image conversion failed");
      currentGroup().push({ blob: blob, width: dimensions.width, height: dimensions.height, mode: elements.scanMode.value });
      requiresPageChange = true;
      lastPageSeenAt = Date.now();
      stableCorners = [];
      elements.flash.classList.remove("active");
      void elements.flash.offsetWidth;
      elements.flash.classList.add("active");
      updateControls();
      showToast("Page added to Document " + documentGroups.length + ".");
      setTimeout(function () {
        if (requiresPageChange) elements.status.textContent = "Move the page away, then show the next one.";
      }, PAGE_CHANGE_DELAY);
    } catch (error) {
      showToast("Could not process this page. Try the capture button again.");
      elements.status.textContent = "Ready to try again.";
    } finally {
      isCapturing = false;
    }
  }

  function manualCapture() {
    const fallbackCorners = pageGuideCorners();
    if (!currentCorners) showToast("Using the " + guideLabel() + " guide. Keep the page inside its dashed border.");
    capturePage(currentCorners || fallbackCorners);
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
          const image = await pdf.embedPng(await scan.blob.arrayBuffer());
          const width = scan.width / DPI * 72;
          const height = scan.height / DPI * 72;
          const page = pdf.addPage([width, height]);
          page.drawImage(image, { x: 0, y: 0, width: width, height: height });
        }
        const bytes = await pdf.save();
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
      note.textContent = file.pages + " " + (file.pages === 1 ? "page" : "pages") + " - " + mode + " - 200 DPI";
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
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
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
  elements.scanMore.addEventListener("click", resetSession);
  elements.reset.addEventListener("click", resetSession);
  elements.manualCapture.addEventListener("click", manualCapture);
  elements.undo.addEventListener("click", undoPage);
  elements.newDocument.addEventListener("click", newDocument);
  elements.finish.addEventListener("click", generatePdfs);
  elements.flashButton.addEventListener("click", toggleFlash);
  elements.downloadZip.addEventListener("click", downloadZip);
  elements.switchCamera.addEventListener("click", function () {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
    startCamera();
  });
  elements.menuButton.addEventListener("click", openMenu);
  elements.closeMenu.addEventListener("click", closeMenu);
  elements.scannerMenu.addEventListener("click", function (event) {
    if (event.target === elements.scannerMenu) closeMenu();
  });
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("resize", function () { if (stream) resizeOverlay(); });
  updateControls();
  setTimeout(startCamera, 0);
})();
