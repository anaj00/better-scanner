/* global cv */

let ready = false;
const pending = [];

self.Module = {
  onRuntimeInitialized: function () {
    ready = true;
    self.postMessage({ type: "ready" });
    while (pending.length) detect(pending.shift());
  }
};

importScripts("https://docs.opencv.org/4.x/opencv.js");

self.onmessage = function (event) {
  if (!ready) pending.push(event.data);
  else detect(event.data);
};

function order(points) {
  const sorted = points.slice().sort(function (a, b) { return a.x + a.y - b.x - b.y; });
  const topLeft = sorted[0];
  const bottomRight = sorted[3];
  const rest = points.filter(function (point) { return point !== topLeft && point !== bottomRight; });
  const topRight = rest[0].x > rest[1].x ? rest[0] : rest[1];
  const bottomLeft = rest[0] === topRight ? rest[1] : rest[0];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

function pointDistance(one, two, width, height) {
  return Math.hypot((one.x - two.x) * width, (one.y - two.y) * height);
}

function scoreRectangle(points, width, height) {
  const top = pointDistance(points[0], points[1], width, height);
  const right = pointDistance(points[1], points[2], width, height);
  const bottom = pointDistance(points[2], points[3], width, height);
  const left = pointDistance(points[3], points[0], width, height);
  const shortest = Math.min(top, right, bottom, left);
  const longest = Math.max(top, right, bottom, left);
  if (shortest < Math.min(width, height) * .2 || longest / shortest > 2.5) return -Infinity;
  const ratio = Math.min((top + bottom) / 2, (left + right) / 2) / Math.max((top + bottom) / 2, (left + right) / 2);
  if (Math.abs(ratio - 8.5 / 14) > .24) return -Infinity;
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
  if (area < .13 || area > .92) return -Infinity;
  return area * (1 - Math.min(.35, Math.hypot(centerX / 4 - .5, centerY / 4 - .5) * .35));
}

function findRectangle(mask, width, height, retrieval, minimumCoverage) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let best;
  let bestScore = -Infinity;
  try {
    cv.findContours(mask, contours, hierarchy, retrieval, cv.CHAIN_APPROX_SIMPLE);
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const area = Math.abs(cv.contourArea(contour));
      if (area >= width * height * minimumCoverage) {
        const perimeter = cv.arcLength(contour, true);
        const approximation = new cv.Mat();
        cv.approxPolyDP(contour, approximation, .018 * perimeter, true);
        let points;
        let score = -Infinity;
        if (approximation.rows === 4 && cv.isContourConvex(approximation)) {
          points = order([0, 1, 2, 3].map(function (point) {
            const value = approximation.intPtr(point, 0);
            return { x: value[0] / width, y: value[1] / height };
          }));
          score = scoreRectangle(points, width, height) + .15;
        } else if (approximation.rows >= 3 && approximation.rows <= 6) {
          const rotated = cv.minAreaRect(contour);
          const rotatedArea = rotated.size.width * rotated.size.height;
          if (rotatedArea && area / rotatedArea > .32) {
            const box = cv.boxPoints(rotated);
            points = order([0, 1, 2, 3].map(function (point) {
              const value = box.floatPtr(point, 0);
              return { x: value[0] / width, y: value[1] / height };
            }));
            box.delete();
            score = scoreRectangle(points, width, height) * (area / rotatedArea);
          }
        }
        approximation.delete();
        if (score > bestScore) { bestScore = score; best = points; }
      }
      contour.delete();
    }
    return best;
  } finally {
    contours.delete();
    hierarchy.delete();
  }
}

function detect(data) {
  const canvas = new OffscreenCanvas(data.width, data.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (data.bitmap) {
    context.drawImage(data.bitmap, 0, 0);
    data.bitmap.close();
  } else {
    context.putImageData(data.imageData, 0, 0);
  }
  const source = cv.imread(canvas);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const closed = new cv.Mat();
  const threshold = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  let corners;
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, 20, 90);
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
    corners = findRectangle(closed, data.width, data.height, cv.RETR_EXTERNAL, .1);
    if (!corners) {
      cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
      cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
      corners = findRectangle(threshold, data.width, data.height, cv.RETR_EXTERNAL, .1);
    }
    if (!corners && data.fallback) {
      corners = findRectangle(closed, data.width, data.height, cv.RETR_LIST, .18);
      if (!corners) {
        cv.threshold(blurred, threshold, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
        cv.morphologyEx(threshold, threshold, cv.MORPH_CLOSE, kernel);
        corners = findRectangle(threshold, data.width, data.height, cv.RETR_LIST, .18);
      }
    }
    self.postMessage({ type: "result", id: data.id, corners: corners || null });
  } finally {
    source.delete(); gray.delete(); blurred.delete(); edges.delete(); closed.delete(); threshold.delete(); kernel.delete();
  }
}
