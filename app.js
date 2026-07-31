/* global cv, PDFLib */
(function () {
  "use strict";

  const PROCESSING_WIDTH = 720;
  const AUTO_CAPTURE_STABLE_FRAMES = 5;
  const DETECTION_INTERVAL = 180;
  const PAGE_REMOVED_DELAY = 650;
  const PAGE_CHANGE_DELAY = 900;
  const DPI = 200;

  const elements = {
    welcome: document.querySelector("#welcome-screen"),
    scanner: document.querySelector("#scanner-screen"),
    results: document.querySelector("#results-screen"),
    start: document.querySelector("#start-button"),
    reset: document.querySelector("#reset-button"),
    scanMore: document.querySelector("#scan-more-button"),
    video: document.querySelector("#camera"),
    outline: document.querySelector("#outline-canvas"),
    status: document.querySelector("#camera-status"),
    switchCamera: document.querySelector("#switch-camera-button"),
    manualCapture: document.querySelector("#manual-capture-button"),
    undo: document.querySelector("#undo-button"),
    newDocument: document.querySelector("#new-document-button"),
    finish: document.querySelector("#finish-button"),
    documentCount: document.querySelector("#document-count"),
    pageCount: document.querySelector("#page-count"),
    pageSize: document.querySelector("#page-size-select"),
    flash: document.querySelector("#capture-flash"),
    resultTitle: document.querySelector("#results-title"),
    resultList: document.querySelector("#results-list"),
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
  }

  function stopCamera() {
    clearInterval(detectionTimer);
    detectionTimer = undefined;
    if (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      stream = undefined;
    }
    elements.video.srcObject = null;
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
      setScreen("scanner");
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
    } finally {
      elements.start.disabled = false;
      elements.start.textContent = "Open camera";
    }
  }

  function startDetection() {
    clearInterval(detectionTimer);
    detectionTimer = setInterval(processFrame, DETECTION_INTERVAL);
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

  function clearOutline() {
    const context = elements.outline.getContext("2d");
    context.clearRect(0, 0, elements.outline.width, elements.outline.height);
  }

  function drawOutline(corners, ready) {
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
    context.strokeStyle = ready ? "#d9fb70" : "#ffffff";
    context.shadowColor = "rgba(0, 0, 0, .55)";
    context.shadowBlur = 8;
    context.stroke();
    context.shadowBlur = 0;
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

  function quadrilateralFromCanvas(canvas) {
    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
      cv.Canny(blurred, edges, 60, 160);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const minimumArea = canvas.width * canvas.height * .13;
      let largest;
      let largestArea = minimumArea;
      for (let index = 0; index < contours.size(); index += 1) {
        const contour = contours.get(index);
        const area = cv.contourArea(contour);
        if (area > largestArea) {
          const perimeter = cv.arcLength(contour, true);
          const approximation = new cv.Mat();
          cv.approxPolyDP(contour, approximation, .02 * perimeter, true);
          if (approximation.rows === 4 && cv.isContourConvex(approximation)) {
            largestArea = area;
            largest = [];
            for (let point = 0; point < 4; point += 1) {
              largest.push({ x: approximation.intPtr(point, 0)[0] / canvas.width, y: approximation.intPtr(point, 0)[1] / canvas.height });
            }
          }
          approximation.delete();
        }
        contour.delete();
      }
      return largest ? orderCorners(largest) : undefined;
    } finally {
      src.delete(); gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete();
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
      clearOutline();
      stableCorners = [];
      if (requiresPageChange && Date.now() - lastPageSeenAt > PAGE_REMOVED_DELAY) {
        requiresPageChange = false;
        elements.status.textContent = "Ready for the next page.";
      } else if (!requiresPageChange) {
        elements.status.textContent = "Finding a page...";
      }
      return;
    }
    lastPageSeenAt = Date.now();
    stableCorners.push(corners);
    if (stableCorners.length > AUTO_CAPTURE_STABLE_FRAMES) stableCorners.shift();
    const stable = stableCorners.length === AUTO_CAPTURE_STABLE_FRAMES && averageCornerMovement(stableCorners) < .012;
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
    return new Promise(function (resolve) { canvas.toBlob(resolve, "image/jpeg", .88); });
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
      const sourcePoints = [];
      corners.forEach(function (point) { sourcePoints.push(point.x * videoWidth, point.y * videoHeight); });
      const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints);
      const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, dimensions.width - 1, 0, dimensions.width - 1, dimensions.height - 1, 0, dimensions.height - 1]);
      const transform = cv.getPerspectiveTransform(sourceMat, destinationMat);
      cv.warpPerspective(source, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY);
      cv.convertScaleAbs(gray, gray, 1.18, -10);
      outputCanvas.width = dimensions.width;
      outputCanvas.height = dimensions.height;
      cv.imshow(outputCanvas, gray);
      const blob = await canvasToBlob(outputCanvas);
      source.delete(); warped.delete(); gray.delete(); sourceMat.delete(); destinationMat.delete(); transform.delete();
      if (!blob) throw new Error("Image conversion failed");
      currentGroup().push({ blob: blob, width: dimensions.width, height: dimensions.height });
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
    const fallbackCorners = [
      { x: .06, y: .06 }, { x: .94, y: .06 }, { x: .94, y: .94 }, { x: .06, y: .94 }
    ];
    if (!currentCorners) showToast("Using a centered crop. Keep the whole page inside the frame.");
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
          const image = await pdf.embedJpg(await scan.blob.arrayBuffer());
          const width = scan.width / DPI * 72;
          const height = scan.height / DPI * 72;
          const page = pdf.addPage([width, height]);
          page.drawImage(image, { x: 0, y: 0, width: width, height: height });
        }
        const bytes = await pdf.save();
        const fileName = "scan-document-" + String(groupIndex + 1).padStart(2, "0") + ".pdf";
        const blob = new Blob([bytes], { type: "application/pdf" });
        generatedFiles.push({ name: fileName, pages: groups[groupIndex].length, blob: blob, url: URL.createObjectURL(blob) });
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
      note.textContent = file.pages + " " + (file.pages === 1 ? "page" : "pages") + " - grayscale - 200 DPI";
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
  elements.switchCamera.addEventListener("click", function () {
    cameraFacing = cameraFacing === "environment" ? "user" : "environment";
    startCamera();
  });
  window.addEventListener("beforeunload", stopCamera);
  window.addEventListener("resize", function () { if (stream) resizeOverlay(); });
  updateControls();
})();
