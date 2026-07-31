# BetterScanner

Client-only mobile document scanner using browser camera APIs, OpenCV.js, pdf-lib, and JSZip. Camera frames and documents remain in the browser; no image upload backend is used.

## Pipeline

1. `app.js` analyzes camera frames at a bounded 720px width using OpenCV.js on the main thread.
2. Detection tries connected Canny edges, normal Otsu thresholding, and inverse Otsu thresholding.
3. It accepts the best page-like contour or rectangular fallback without confidence scoring or image fingerprinting.
4. Auto-capture requires two detected frames with average corner movement below `0.008`; detection runs every 100ms.
5. Capture prefers a full-resolution `ImageCapture.takePhoto()` still, maps the preview corners onto it, and falls back to the current video frame when unsupported. Perspective correction preserves the detected rectangle's natural aspect ratio and review image.
6. The camera rearms after the page has been absent for 650ms. Users can continue scanning into the current filmstrip or start another document.
7. Original mode exports the exact preserved review image. Grayscale preserves natural luminance, while B&W gently normalizes page lighting and applies mild denoising and contrast. `processing-worker.js` is reserved for imported images and explicit filmstrip edits.
8. Every scan is centered and aspect-fitted without stretching onto a US Legal PDF page. PDFs can be shared separately or bundled into a ZIP.

## Run

Camera access requires HTTPS on phones. Deploy the directory as a static site:

```sh
npx vercel --prod
```

## Debugging

Open `/debug.html` to test uploaded fixture images against the experimental worker detector. The camera scanner itself uses the simpler detector in `app.js`.

Recommended fixture set:

- White page on dark and light tables
- Legal MOA, A4, Letter, and receipt
- Strong perspective, rotated page, and partially clipped page
- Partial shadow, low light, and glare
- Form with many internal rectangular fields

The fixture page displays the worker detector's selected quadrilateral, confidence, mask, candidate count, and quality metrics. Add fixtures by keeping images locally and selecting them through the file input; images are not uploaded.

## Mobile Testing

On iPhone Safari, Android Chrome, and Samsung Internet, test camera permission denial, rear-camera selection, uninterrupted manual and automatic multi-page capture, remove-page rearming, filmstrip editing, retake, undo, document boundaries, PDF sharing, and ZIP saving. Also background/resume the browser during an active session.

## Limitations

This is a browser approximation, not Apple Notes parity. `ImageCapture`, torch, camera selection, and downloadable file behavior vary by browser. Safari commonly uses the video-frame fallback. Large perspective-corrected images can briefly pause slower phones.
