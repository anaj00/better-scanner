/* global cv, ScannerGeometry */

let ready = false;
let pendingJob = null;

self.Module = {
  onRuntimeInitialized: function () {
    ready = true;
    self.postMessage({ type: "ready" });
    if (pendingJob) { const job = pendingJob; pendingJob = null; processJob(job); }
  }
};

importScripts("geometry.js", "https://docs.opencv.org/4.x/opencv.js");

self.onmessage = function (event) {
  if (event.data.type !== "process") return;
  if (!ready) pendingJob = event.data;
  else processJob(event.data);
};

function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function outputDimensions(corners, width, height, maximumDimension, maximumPixels) {
  const points = corners.map(function (point) { return { x: point.x * width, y: point.y * height }; });
  const outputWidth = Math.max(distance(points[0], points[1]), distance(points[3], points[2]));
  const outputHeight = Math.max(distance(points[0], points[3]), distance(points[1], points[2]));
  const scale = Math.min(1, maximumDimension / Math.max(outputWidth, outputHeight), Math.sqrt(maximumPixels / (outputWidth * outputHeight)));
  return { width: Math.max(1, Math.round(outputWidth * scale)), height: Math.max(1, Math.round(outputHeight * scale)) };
}

function refineCorners(gray, corners) {
  const width = gray.cols; const height = gray.rows; let originalSupport = 0; let refinedSupport = 0;
  const lines = corners.map(function (point, side) {
    const next = corners[(side + 1) % 4]; const ax = point.x * width; const ay = point.y * height; const bx = next.x * width; const by = next.y * height;
    const dx = bx - ax; const dy = by - ay; const length = Math.hypot(dx, dy); const nx = -dy / length; const ny = dx / length; const samples = [];
    for (let step = 2; step <= 18; step += 1) {
      const t = step / 20; const x = ax + dx * t; const y = ay + dy * t; let bestOffset = 0; let bestGradient = 0;
      for (let offset = -18; offset <= 18; offset += 2) {
        const x1 = Math.max(0, Math.min(width - 1, Math.round(x + nx * (offset - 2)))); const y1 = Math.max(0, Math.min(height - 1, Math.round(y + ny * (offset - 2))));
        const x2 = Math.max(0, Math.min(width - 1, Math.round(x + nx * (offset + 2)))); const y2 = Math.max(0, Math.min(height - 1, Math.round(y + ny * (offset + 2)))); const gradient = Math.abs(gray.data[y2 * width + x2] - gray.data[y1 * width + x1]);
        if (gradient > bestGradient) { bestGradient = gradient; bestOffset = offset; }
        if (offset === 0) originalSupport += gradient;
      }
      refinedSupport += bestGradient; samples.push({ x: x + nx * bestOffset, y: y + ny * bestOffset });
    }
    const center = samples.reduce(function (sum, sample) { return { x: sum.x + sample.x / samples.length, y: sum.y + sample.y / samples.length }; }, { x: 0, y: 0 });
    let xx = 0; let xy = 0; let yy = 0; samples.forEach(function (sample) { const x = sample.x - center.x; const y = sample.y - center.y; xx += x * x; xy += x * y; yy += y * y; });
    const angle = .5 * Math.atan2(2 * xy, xx - yy); const normal = { x: -Math.sin(angle), y: Math.cos(angle) }; return { a: normal.x, b: normal.y, c: -(normal.x * center.x + normal.y * center.y) };
  });
  function intersect(one, two) { const determinant = one.a * two.b - two.a * one.b; if (Math.abs(determinant) < .0001) return null; return { x: (one.b * two.c - two.b * one.c) / determinant / width, y: (one.c * two.a - two.c * one.a) / determinant / height }; }
  const refined = ScannerGeometry.orderCorners([intersect(lines[3], lines[0]), intersect(lines[0], lines[1]), intersect(lines[1], lines[2]), intersect(lines[2], lines[3])].filter(Boolean));
  if (!refined) return { corners: corners, confidence: 0, conflict: false };
  const movement = refined.reduce(function (sum, point, index) { return sum + distance(point, corners[index]); }, 0) / 4;
  const improvement = originalSupport ? refinedSupport / originalSupport : 1;
  const accepted = movement <= .08 && improvement >= 1.08;
  return { corners: accepted ? refined : corners, confidence: accepted ? Math.min(1, (improvement - 1) * 2 + .55) : .2, conflict: movement > .08 };
}

function applyLocalContrast(source, destination, clipLimit) {
  let clahe;
  try { clahe = cv.createCLAHE(clipLimit, new cv.Size(8, 8)); clahe.apply(source, destination); }
  catch (error) { cv.equalizeHist(source, destination); }
  finally { if (clahe) clahe.delete(); }
}

function processMode(warped, mode, mats) {
  if (mode === "original") { const output = warped.clone(); mats.push(output); return output; }
  if (mode === "enhanced-color") {
    const rgb = new cv.Mat(); const lab = new cv.Mat(); const outputRgb = new cv.Mat(); const output = new cv.Mat(); const channels = new cv.MatVector(); mats.push(rgb, lab, outputRgb, output, channels);
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab); cv.split(lab, channels);
    const luminance = channels.get(0); const channelA = channels.get(1); const channelB = channels.get(2); const background = new cv.Mat(); const normalized = new cv.Mat(); const enhancedL = new cv.Mat(); const merged = new cv.MatVector(); mats.push(luminance, channelA, channelB, background, normalized, enhancedL, merged);
    cv.GaussianBlur(luminance, background, new cv.Size(0, 0), Math.max(12, Math.round(Math.max(warped.rows, warped.cols) / 45))); cv.divide(luminance, background, normalized, 210); applyLocalContrast(normalized, enhancedL, 1.6);
    merged.push_back(enhancedL); merged.push_back(channelA); merged.push_back(channelB); cv.merge(merged, lab); cv.cvtColor(lab, outputRgb, cv.COLOR_Lab2RGB); cv.cvtColor(outputRgb, output, cv.COLOR_RGB2RGBA); return output;
  }
  const gray = new cv.Mat(); const background = new cv.Mat(); const normalized = new cv.Mat(); mats.push(gray, background, normalized); cv.cvtColor(warped, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, background, new cv.Size(0, 0), Math.max(12, Math.round(Math.max(warped.rows, warped.cols) / 45))); cv.divide(gray, background, normalized, mode === "grayscale" ? 215 : 220);
  if (mode === "grayscale") { const output = new cv.Mat(); mats.push(output); applyLocalContrast(normalized, output, 1.5); return output; }
  const blurred = new cv.Mat(); const output = new cv.Mat(); mats.push(blurred, output); cv.GaussianBlur(normalized, blurred, new cv.Size(3, 3), 0); let blockSize = Math.round(Math.min(warped.rows, warped.cols) / 30) | 1; blockSize = Math.max(31, Math.min(81, blockSize)); cv.adaptiveThreshold(blurred, output, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, blockSize, 10); return output;
}

function processJob(job) {
  const started = performance.now(); const mats = [];
  try {
    const pixels = new Uint8ClampedArray(job.buffer); const source = cv.matFromImageData(new ImageData(pixels, job.width, job.height)); const oriented = new cv.Mat(); const gray = new cv.Mat(); mats.push(source, oriented, gray);
    if (job.rotation === 1) cv.rotate(source, oriented, cv.ROTATE_90_CLOCKWISE); else if (job.rotation === 2) cv.rotate(source, oriented, cv.ROTATE_180); else if (job.rotation === 3) cv.rotate(source, oriented, cv.ROTATE_90_COUNTERCLOCKWISE); else source.copyTo(oriented);
    cv.cvtColor(oriented, gray, cv.COLOR_RGBA2GRAY);
    const refinementStarted = performance.now(); const refinement = refineCorners(gray, job.corners); const refinementMs = performance.now() - refinementStarted;
    const dimensions = outputDimensions(refinement.corners, oriented.cols, oriented.rows, job.maximumDimension, job.maximumPixels); if (Math.min(dimensions.width, dimensions.height) < 320) throw new Error("Crop is too small");
    const sourcePoints = []; refinement.corners.forEach(function (point) { sourcePoints.push(point.x * oriented.cols, point.y * oriented.rows); });
    const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourcePoints); const destinationMat = cv.matFromArray(4, 1, cv.CV_32FC2, [0,0,dimensions.width-1,0,dimensions.width-1,dimensions.height-1,0,dimensions.height-1]); const transform = cv.getPerspectiveTransform(sourceMat, destinationMat); const warped = new cv.Mat(); mats.push(sourceMat, destinationMat, transform, warped);
    const transformStarted = performance.now(); cv.warpPerspective(oriented, warped, transform, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_REPLICATE); const transformMs = performance.now() - transformStarted;
    const enhancementStarted = performance.now(); const output = processMode(warped, job.mode, mats); const enhancementMs = performance.now() - enhancementStarted;
    const rgba = new cv.Mat(); mats.push(rgba); if (output.channels() === 1) cv.cvtColor(output, rgba, cv.COLOR_GRAY2RGBA); else if (output.channels() === 3) cv.cvtColor(output, rgba, cv.COLOR_RGB2RGBA); else output.copyTo(rgba);
    const buffer = new Uint8ClampedArray(rgba.data).buffer;
    self.postMessage({ type: "processed", pageId: job.pageId, revision: job.revision, generation: job.generation, width: dimensions.width, height: dimensions.height, buffer: buffer, refinedCorners: refinement.corners, refinementConfidence: refinement.confidence, refinementConflict: refinement.conflict, mimeType: job.mode === "black-and-white" ? "image/png" : "image/jpeg", timings: { refinementMs: refinementMs, transformMs: transformMs, enhancementMs: enhancementMs, workerTotalMs: performance.now() - started } }, [buffer]);
  } catch (error) {
    self.postMessage({ type: "error", pageId: job.pageId, revision: job.revision, generation: job.generation, message: error && error.message ? error.message : "Processing failed" });
  } finally { mats.reverse().forEach(function (mat) { if (mat) mat.delete(); }); }
}
