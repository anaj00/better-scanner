(function (scope) {
  "use strict";

  function signedArea(points) {
    return points.reduce(function (sum, point, index) {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2;
  }

  function validateQuad(points) {
    if (!points || points.length !== 4 || points.some(function (point) { return !Number.isFinite(point.x) || !Number.isFinite(point.y); })) return false;
    if (Math.abs(signedArea(points)) < .01) return false;
    let sign = 0;
    for (let index = 0; index < 4; index += 1) {
      const a = points[index]; const b = points[(index + 1) % 4]; const c = points[(index + 2) % 4];
      if (Math.hypot(a.x - b.x, a.y - b.y) < .04) return false;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < .0001) return false;
      if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }

  function orderCorners(input) {
    if (!input || input.length !== 4) return null;
    const center = input.reduce(function (sum, point) { return { x: sum.x + point.x / 4, y: sum.y + point.y / 4 }; }, { x: 0, y: 0 });
    let points = input.map(function (point) { return { x: Number(point.x), y: Number(point.y) }; }).sort(function (a, b) { return Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x); });
    if (signedArea(points) < 0) points.reverse();
    let start = 0;
    points.forEach(function (point, index) { const current = points[start]; if (point.y < current.y - .02 || Math.abs(point.y - current.y) <= .02 && point.x < current.x) start = index; });
    points = points.slice(start).concat(points.slice(0, start));
    if (points[1].x < points[3].x) points = [points[0], points[3], points[2], points[1]];
    return validateQuad(points) ? points : null;
  }

  function runTests() {
    const fixtures = [
      [[.1,.1],[.8,.1],[.8,.9],[.1,.9]], [[.1,.2],[.9,.2],[.9,.7],[.1,.7]],
      [[.3,.05],[.9,.3],[.7,.95],[.1,.7]], [[.18,.1],[.82,.18],[.94,.9],[.05,.75]],
      [[.5,.04],[.96,.5],[.5,.96],[.04,.5]]
    ];
    return fixtures.every(function (fixture) { return Boolean(orderCorners(fixture.map(function (point) { return { x: point[0], y: point[1] }; }))); });
  }

  scope.ScannerGeometry = { orderCorners: orderCorners, validateQuad: validateQuad, signedArea: signedArea, runTests: runTests };
})(typeof self !== "undefined" ? self : window);
