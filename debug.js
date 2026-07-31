(function () {
  "use strict";
  const input = document.querySelector("#fixture"); const canvas = document.querySelector("#debug-canvas"); const output = document.querySelector("#debug-output"); const worker = new Worker("detector-worker.js");
  worker.onmessage = function (event) {
    if (event.data.type !== "result") return;
    output.textContent = JSON.stringify(event.data, null, 2);
    if (!event.data.corners) return;
    const context = canvas.getContext("2d"); context.beginPath(); event.data.corners.forEach(function (point, index) { const x = point.x * canvas.width; const y = point.y * canvas.height; index ? context.lineTo(x, y) : context.moveTo(x, y); }); context.closePath(); context.strokeStyle = "#d7f770"; context.lineWidth = 4; context.stroke();
  };
  input.addEventListener("change", async function () {
    const file = input.files && input.files[0]; if (!file) return; const bitmap = await createImageBitmap(file); const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height)); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); const context = canvas.getContext("2d", { willReadFrequently: true }); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close(); const imageData = context.getImageData(0, 0, canvas.width, canvas.height); worker.postMessage({ type: "detect", id: Date.now(), width: canvas.width, height: canvas.height, sentAt: performance.now(), buffer: imageData.data.buffer }, [imageData.data.buffer]);
  });
})();
