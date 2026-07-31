/* global cv, ScannerGeometry */

const pending = { frame: null };
let ready = false;
let previousCorners = null;

self.Module = {
  onRuntimeInitialized: function () {
    ready = true;
    self.postMessage({ type: "ready", tests: ScannerGeometry.runTests() });
    if (pending.frame) {
      const frame = pending.frame;
      pending.frame = null;
      detect(frame);
    }
  }
};

importScripts("geometry.js", "https://docs.opencv.org/4.x/opencv.js");

self.onmessage = function (event) {
  if (event.data.type === "reset") {
    previousCorners = null;
    pending.frame = null;
    return;
  }
  if (event.data.type !== "detect") return;
  if (!ready) pending.frame = event.data;
  else detect(event.data);
};

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function pointsFromMat(mat, width, height, floating) {
  const data = floating ? mat.data32F : mat.data32S;
  return ScannerGeometry.orderCorners([0, 1, 2, 3].map(function (index) { return { x: data[index * 2] / width, y: data[index * 2 + 1] / height }; }));
}

function angleScore(points, width, height) {
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    const previous = points[(i + 3) % 4]; const current = points[i]; const next = points[(i + 1) % 4];
    const ax = (previous.x - current.x) * width; const ay = (previous.y - current.y) * height;
    const bx = (next.x - current.x) * width; const by = (next.y - current.y) * height;
    const cosine = clamp((ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)), -1, 1);
    const angle = Math.acos(cosine) * 180 / Math.PI;
    if (angle < 25 || angle > 155) return 0;
    total += Math.exp(-Math.pow((angle - 90) / 42, 2));
  }
  return total / 4;
}

function sampleEdgeSupport(points, edgeData, grayData, width, height) {
  let coverageTotal = 0; let weakest = 1; let contrastTotal = 0; let contrastEdges = 0;
  const center = points.reduce(function (sum, point) { return { x: sum.x + point.x / 4, y: sum.y + point.y / 4 }; }, { x: 0, y: 0 });
  for (let side = 0; side < 4; side += 1) {
    const a = { x: points[side].x * width, y: points[side].y * height };
    const b = { x: points[(side + 1) % 4].x * width, y: points[(side + 1) % 4].y * height };
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.hypot(dx, dy);
    let nx = -dy / length; let ny = dx / length;
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if ((center.x * width - midpoint.x) * nx + (center.y * height - midpoint.y) * ny < 0) { nx *= -1; ny *= -1; }
    let hits = 0; let samples = 0; let contrast = 0;
    for (let t = .12; t <= .88; t += .04) {
      const x = a.x + dx * t; const y = a.y + dy * t;
      let hit = false;
      for (let offset = -2; offset <= 2; offset += 1) {
        const px = clamp(Math.round(x + nx * offset), 0, width - 1); const py = clamp(Math.round(y + ny * offset), 0, height - 1);
        if (edgeData[py * width + px] > 0) hit = true;
      }
      const ix = clamp(Math.round(x + nx * 7), 0, width - 1); const iy = clamp(Math.round(y + ny * 7), 0, height - 1);
      const ox = clamp(Math.round(x - nx * 7), 0, width - 1); const oy = clamp(Math.round(y - ny * 7), 0, height - 1);
      contrast += grayData[iy * width + ix] - grayData[oy * width + ox];
      hits += hit ? 1 : 0; samples += 1;
    }
    const coverage = hits / samples; const signedContrast = contrast / samples;
    coverageTotal += coverage; weakest = Math.min(weakest, coverage); contrastTotal += signedContrast;
    if (signedContrast > 5) contrastEdges += 1;
  }
  return { edgeCoverage: coverageTotal / 4, weakestEdgeCoverage: weakest, signedBorderContrast: contrastTotal / 4, positiveContrastEdges: contrastEdges };
}

function candidateFromContour(contour, maskName, gray, edgeMask, width, height) {
  const contourArea = Math.abs(cv.contourArea(contour)); const frameArea = width * height;
  const areaRatio = contourArea / frameArea;
  if (areaRatio < .12 || areaRatio > .93) return null;
  const perimeter = cv.arcLength(contour, true);
  let points = null; let approximation = "quad";
  for (const epsilon of [.012, .018, .026, .035]) {
    const approx = new cv.Mat();
    cv.approxPolyDP(contour, approx, epsilon * perimeter, true);
    if (approx.rows === 4 && cv.isContourConvex(approx)) points = pointsFromMat(approx, width, height, false);
    approx.delete();
    if (points) break;
  }
  if (!points) {
    const rotated = cv.minAreaRect(contour); const rotatedArea = rotated.size.width * rotated.size.height;
    if (!rotatedArea || contourArea / rotatedArea < .68) return null;
    const box = cv.boxPoints(rotated);
    points = Array.isArray(box)
      ? ScannerGeometry.orderCorners(box.map(function (point) { return { x: point.x / width, y: point.y / height }; }))
      : pointsFromMat(box, width, height, true);
    if (box && typeof box.delete === "function") box.delete();
    approximation = "min-area";
  }
  if (!points) return null;
  const polygonArea = Math.abs(ScannerGeometry.signedArea(points));
  const rectangularity = clamp(areaRatio / polygonArea, 0, 1);
  const angles = angleScore(points, width, height);
  if (!angles) return null;
  const margin = Math.min.apply(null, points.map(function (point) { return Math.min(point.x, point.y, 1 - point.x, 1 - point.y); }));
  if (margin < -.01 || areaRatio > .88 && margin < .015) return null;
  const center = points.reduce(function (sum, point) { return { x: sum.x + point.x / 4, y: sum.y + point.y / 4 }; }, { x: 0, y: 0 });
  const centerScore = clamp(1 - Math.hypot(center.x - .5, center.y - .5) / .7, 0, 1);
  const evidence = sampleEdgeSupport(points, edgeMask.data, gray.data, width, height);
  const sides = [distance(points[0], points[1]), distance(points[1], points[2]), distance(points[2], points[3]), distance(points[3], points[0])];
  const aspectRatio = Math.min((sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2) / Math.max((sides[0] + sides[2]) / 2, (sides[1] + sides[3]) / 2);
  const previousScore = previousCorners ? clamp(1 - points.reduce(function (sum, point, index) { return sum + distance(point, previousCorners[index]); }, 0) / .4, 0, 1) : .5;
  const internalPenalty = evidence.signedBorderContrast < 5 && evidence.positiveContrastEdges < 3 ? .3 : 0;
  let confidence = clamp(.18 * clamp((areaRatio - .12) / .5, 0, 1) + .14 * rectangularity + .12 * angles + .24 * evidence.edgeCoverage + .1 * evidence.weakestEdgeCoverage + .08 * centerScore + .08 * clamp(margin / .08, 0, 1) + .06 * previousScore - internalPenalty, 0, 1);
  if (approximation === "min-area") confidence = Math.min(confidence, .62);
  return { corners: points, confidence: confidence, approximation: approximation, metrics: { areaRatio: areaRatio, rectangularity: rectangularity, angleScore: angles, edgeScore: evidence.edgeCoverage, centerScore: centerScore, borderMargin: margin, aspectRatio: aspectRatio, weakestEdgeCoverage: evidence.weakestEdgeCoverage, signedBorderContrast: evidence.signedBorderContrast } , maskUsed: maskName };
}

function collectCandidates(mask, maskName, gray, edgeMask, width, height) {
  const contours = new cv.MatVector(); const hierarchy = new cv.Mat(); const candidates = [];
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index); const candidate = candidateFromContour(contour, maskName, gray, edgeMask, width, height); contour.delete();
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  } finally { contours.delete(); hierarchy.delete(); }
}

function qualityMetrics(gray, corners, width, height) {
  const laplacian = new cv.Mat();
  try {
    cv.Laplacian(gray, laplacian, cv.CV_16S, 3);
    let count = 0; let sum = 0; let lapSum = 0; let lapSquared = 0; let over = 0; let under = 0; const bright = new Set();
    function inside(x, y) { let result = false; for (let i = 0, j = 3; i < 4; j = i++) { const a = corners[i]; const b = corners[j]; if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) result = !result; } return result; }
    const minX = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function (p) { return p.x; })) * width));
    const maxX = Math.min(width - 1, Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.x; })) * width));
    const minY = Math.max(0, Math.floor(Math.min.apply(null, corners.map(function (p) { return p.y; })) * height));
    const maxY = Math.min(height - 1, Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.y; })) * height));
    for (let y = minY; y <= maxY; y += 2) for (let x = minX; x <= maxX; x += 2) {
      if (!inside(x / width, y / height)) continue;
      const value = gray.data[y * width + x]; const lap = laplacian.data16S[y * width + x];
      count += 1; sum += value; lapSum += lap; lapSquared += lap * lap; over += value >= 250 ? 1 : 0; under += value <= 8 ? 1 : 0;
      if (value >= 252) bright.add(x + ":" + y);
    }
    const mean = count ? sum / count : 0; const lapMean = count ? lapSum / count : 0;
    let largest = 0;
    while (bright.size) {
      const first = bright.values().next().value; const queue = [first]; bright.delete(first); let size = 0;
      while (queue.length) { const key = queue.pop(); size += 1; const parts = key.split(":"); const x = Number(parts[0]); const y = Number(parts[1]); [[2,0],[-2,0],[0,2],[0,-2]].forEach(function (offset) { const next = x + offset[0] + ":" + (y + offset[1]); if (bright.delete(next)) queue.push(next); }); }
      largest = Math.max(largest, size);
    }
    const brightRegionRatio = count ? largest / count : 0; const glareRatio = brightRegionRatio >= .02 && brightRegionRatio <= .35 ? brightRegionRatio : 0;
    return { blurScore: count ? lapSquared / count - lapMean * lapMean : 0, brightness: mean, overexposure: count ? over / count : 1, underexposure: count ? under / count : 1, glareRatio: glareRatio };
  } finally { laplacian.delete(); }
}

function detect(frame) {
  const mats = [];
  try {
    const pixels = new Uint8ClampedArray(frame.buffer); const imageData = new ImageData(pixels, frame.width, frame.height);
    const source = cv.matFromImageData(imageData); mats.push(source);
    const gray = new cv.Mat(); const blurred = new cv.Mat(); mats.push(gray, blurred);
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    const sampled = []; for (let index = 0; index < gray.data.length; index += 16) sampled.push(gray.data[index]); sampled.sort(function (a, b) { return a - b; });
    const median = sampled[Math.floor(sampled.length / 2)] || 128; const autoLow = Math.max(18, Math.round(median * .55)); const autoHigh = Math.min(220, Math.round(median * 1.35));
    const masks = [];
    function addMask(name, mat) { mats.push(mat); masks.push({ name: name, mat: mat }); }
    const canny = new cv.Mat(); cv.Canny(blurred, canny, autoLow, autoHigh); addMask("canny-auto", canny);
    const wide = new cv.Mat(); cv.Canny(blurred, wide, Math.max(12, autoLow * .65), Math.min(240, autoHigh * 1.35)); addMask("canny-wide", wide);
    const kernelSize = Math.max(3, Math.round(Math.min(frame.width, frame.height) / 120) | 1); const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kernelSize, kernelSize)); mats.push(kernel);
    masks.forEach(function (entry) { cv.morphologyEx(entry.mat, entry.mat, cv.MORPH_CLOSE, kernel); });
    const adaptive = new cv.Mat(); cv.adaptiveThreshold(blurred, adaptive, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 7); addMask("adaptive", adaptive);
    const otsu = new cv.Mat(); cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU); addMask("otsu", otsu);
    const inverse = new cv.Mat(); cv.threshold(blurred, inverse, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU); addMask("otsu-inverse", inverse);
    let candidates = [];
    masks.forEach(function (entry) { candidates = candidates.concat(collectCandidates(entry.mat, entry.name, gray, canny, frame.width, frame.height)); });
    candidates.sort(function (a, b) { return b.confidence - a.confidence; });
    const winner = candidates[0] && candidates[0].confidence >= .48 ? candidates[0] : null;
    if (winner) previousCorners = winner.corners;
    const quality = winner ? qualityMetrics(gray, winner.corners, frame.width, frame.height) : null;
    self.postMessage({ type: "result", id: frame.id, sessionId: frame.sessionId, corners: winner ? winner.corners : null, confidence: winner ? winner.confidence : 0, metrics: winner ? Object.assign({}, winner.metrics, quality) : null, diagnostics: { maskUsed: winner ? winner.maskUsed : "none", candidateCount: candidates.length }, processingMs: performance.now() - frame.sentAt });
  } catch (error) {
    self.postMessage({ type: "error", id: frame.id, message: error && error.message ? error.message : "Detector error" });
  } finally { mats.reverse().forEach(function (mat) { if (mat) mat.delete(); }); }
}
