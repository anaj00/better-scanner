/* global cv */

let cvReady = false;
const queuedFrames = [];

self.Module = {
  onRuntimeInitialized: function () {
    cvReady = true;
    self.postMessage({ type: "ready" });
    while (queuedFrames.length) detect(queuedFrames.shift());
  }
};

importScripts("https://docs.opencv.org/4.x/opencv.js");

self.onmessage = function (event) {
  if (cvReady) detect(event.data);
  else queuedFrames.push(event.data);
};

function orderCorners(points) {
  const sorted = points.slice().sort(function (a, b) { return a.x + a.y - b.x - b.y; });
  const topLeft = sorted[0];
  const bottomRight = sorted[3];
  const rest = points.filter(function (point) { return point !== topLeft && point !== bottomRight; });
  const topRight = rest[0].x > rest[1].x ? rest[0] : rest[1];
  const bottomLeft = rest[0] === topRight ? rest[1] : rest[0];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function distance(one, two, width, height) {
  return Math.hypot((one.x - two.x) * width, (one.y - two.y) * height);
}

function scoreRectangle(points, width, height) {
  const top = distance(points[0], points[1], width, height);
  const right = distance(points[1], points[2], width, height);
  const bottom = distance(points[2], points[3], width, height);
  const left = distance(points[3], points[0], width, height);
  const shortest = Math.min(top, right, bottom, left);
  const longest = Math.max(top, right, bottom, left);
  if (shortest < Math.min(width, height) * .14 || longest / shortest > 3.2) return -Infinity;

  let area = 0;
  let centerX = 0;
  let centerY = 0;
  points.forEach(function (point, index) {
    const next = points[(index + 1) % 4];
    area += point.x * next.y - next.x * point.y;
    centerX += point.x;
    centerY += point.y;
  });
  area = Math.abs(area) / 2;
  if (area < .08 || area > .92) return -Infinity;

  const pageRatio = Math.min((top + bottom) / 2, (left + right) / 2) / Math.max((top + bottom) / 2, (left + right) / 2);
  const legalMatch = Math.max(0, 1 - Math.abs(pageRatio - 8.5 / 14) * 1.4);
  const centerDistance = Math.hypot(centerX / 4 - .5, centerY / 4 - .5);
  return area * legalMatch * (1 - Math.min(.35, centerDistance * .35));
}

function pointsFromMat(mat, width, height, floating) {
  const points = [];
  for (let index = 0; index < 4; index += 1) {
    const point = floating ? mat.floatPtr(index, 0) : mat.intPtr(index, 0);
    points.push({ x: point[0] / width, y: point[1] / height });
  }
  return orderCorners(points);
}

function findPage(mask, width, height) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best;
  let bestScore = -Infinity;
  try {
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      if (area < width * height * .1) {
        contour.delete();
        continue;
      }
      const approximation = new cv.Mat();
      const perimeter = cv.arcLength(contour, true);
      cv.approxPolyDP(contour, approximation, .018 * perimeter, true);
      let points;
      let score = -Infinity;
      if (approximation.rows === 4 && cv.isContourConvex(approximation)) {
        points = pointsFromMat(approximation, width, height, false);
        score = scoreRectangle(points, width, height) + .15;
      } else if (approximation.rows >= 3 && approximation.rows <= 6) {
        const rotated = cv.minAreaRect(contour);
        const rotatedArea = rotated.size.width * rotated.size.height;
        if (rotatedArea && area / rotatedArea > .32) {
          const box = cv.boxPoints(rotated);
          points = pointsFromMat(box, width, height, true);
          score = scoreRectangle(points, width, height) * (area / rotatedArea);
          box.delete();
        }
      }
      approximation.delete();
      contour.delete();
      if (score > bestScore) {
        best = points;
        bestScore = score;
      }
    }
    return best;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function detect(frame) {
  let source;
  let gray;
  let blurred;
  let edges;
  let closed;
  let threshold;
  let kernel;
  let corners;
  try {
    source = cv.matFromImageData(frame.imageData);
    gray = new cv.Mat();
    blurred = new cv.Mat();
    edges = new cv.Mat();
    closed = new cv.Mat();
    threshold = new cv.Mat();
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 20, 90);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    corners = findPage(closed, frame.width, frame.height);
    if (!corners) {
      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
      corners = findPage(threshold, frame.width, frame.height);
    }
    self.postMessage({ type: "result", id: frame.id, corners: corners || null });
  } catch (error) {
    self.postMessage({ type: "error", id: frame.id, message: error && error.message ? error.message : "Detector error" });
  } finally {
    [source, gray, blurred, edges, closed, threshold, kernel].forEach(function (mat) {
      if (mat) mat.delete();
    });
  }
}
