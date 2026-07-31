# Paper Trail Scanner

Client-only mobile document scanner. It uses the phone camera, detects pages with OpenCV.js, creates black-and-white PDFs at an effective 200 DPI, and never uploads scans to a server.

## Use Tonight

The camera requires HTTPS on a phone. From this directory, deploy it as a static Vercel site:

```sh
npx vercel --prod
```

Open the URL on an iPhone or Android phone, grant camera access, and use the rear camera.

## Scan Workflow

1. Keep one page in view until it captures automatically. Use the center capture button if needed.
2. Tap **New document** after the last page of a document.
3. Continue scanning the next document without closing the camera.
4. Tap **Finish scans** to generate one PDF for every document boundary.
5. Use **Download all (.zip)** to save every PDF in one archive. Use the individual Share/Open actions when PDFs need to be saved separately.

PDF pages are US Legal at an effective 200 DPI. Text (B&W) is the default; grayscale and color are also available before capturing a page. Flash uses the browser torch API where the phone and browser support it; iPhone Safari may not expose that control.

Live page detection runs in `detector-worker.js` so contour processing does not block camera rendering. The worker uses transferable `ImageBitmap` frames where available and an `ImageData` fallback for browsers that do not support that transfer path.

## Compatibility

Target browsers are iPhone Safari, Android Chrome, Samsung Internet, and other modern mobile browsers with `getUserMedia()` camera access. A camera-switch control and manual crop fallback are available for devices where rear-camera selection or automatic page detection is imperfect.
