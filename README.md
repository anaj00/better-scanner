# BetterScanner

Client-only mobile document scanner using browser camera APIs, OpenCV.js, pdf-lib, and JSZip. Camera frames and documents remain in the browser; no image upload backend is used.

## Pipeline

1. `detector-worker.js` analyzes bounded 480px frames off the UI thread.
2. It evaluates auto/wide Canny, adaptive threshold, and normal/inverse Otsu masks.
3. Candidates are scored using area, rectangularity, angles, edge support, border contrast, margins, center position, and temporal similarity. Detection does not prefer Legal-shaped contours.
4. The overlay is exponentially smoothed (`alpha = 0.38`). A changed candidate resets smoothing and readiness.
5. Auto-capture requires six stable results, confidence of at least `0.70`, acceptable exposure/focus, and at least 900ms sustained readiness.
6. Capture prefers `ImageCapture.takePhoto()` and falls back to the intrinsic video frame.
7. Approximate preview corners are mapped to the still and locally refined. Every capture then opens the draggable corner editor.
8. Perspective correction uses measured edge lengths and never stretches the crop to a paper ratio.
9. Pages are generated as Enhanced color (default), Grayscale, Black and white, or Original. Color/grayscale use JPEG; B&W uses PNG.
10. PDFs use US Legal page dimensions and fit the natural scan without distortion. PDFs can be shared separately or bundled into a ZIP.

## Run

Camera access requires HTTPS on phones. Deploy the directory as a static site:

```sh
npx vercel --prod
```

## Debugging

Open `/?debug=1` to show confidence, blur score, and winning mask in the camera status. Open `/debug.html` to test uploaded fixture images.

Recommended fixture set:

- White page on dark and light tables
- Legal MOA, A4, Letter, and receipt
- Strong perspective, rotated page, and partially clipped page
- Partial shadow, low light, and glare
- Form with many internal rectangular fields

The fixture page displays the selected quadrilateral, confidence, mask, candidate count, and quality metrics. Add fixtures by keeping images locally and selecting them through the file input; images are not uploaded.

## Mobile Testing

On iPhone Safari and Android Chrome, test camera permission denial, rear-camera selection, manual capture, auto-capture on/off, review handle dragging, rotation, all four processing modes, retake, undo, document boundaries, PDF sharing, and ZIP saving. Also background/resume the browser during an active session.

## Limitations

This is a browser approximation, not Apple Notes parity. `ImageCapture`, torch, camera selection, still-photo framing, and downloadable file behavior vary by browser. Safari often uses the video-frame fallback. The review editor remains authoritative when still-photo framing differs from the preview. Large scan batches can exceed a mobile browser's memory limit; pages are bounded to a 2400px maximum dimension and generated sequentially.
