# Local nutrition-label OCR

Open **Saved foods > Scan label**, or **Scan nutrition label** from the barcode scanner, including when a lookup returns an incorrect match. Take a photo or choose an existing JPEG, PNG, or WebP, review the extracted values, and enter a title before choosing **Save food**. The food is reusable in food search, logs, and recipes.

The initial parser supports English Nutrition Facts panels with an explicit serving size and a single Calories value. It reads decimal and fractional serving quantities and preserves the printed unit, including metric equivalents such as `2 tbsp (32 g)`. Calories remain the amount for that entire serving. Calibrate currently stores calories for saved foods; other nutrients on the panel are not imported.

Missing or unclear fields remain empty. Per-100g panels, multiple calorie columns, and other ambiguous bases require manual calorie entry. Users can correct all fields or enter the details manually if recognition fails.

## Server operation

[scan.ts](scan.ts) bounds and cancels work; [ocr.ts](ocr.ts) contains the isolated
worker; [parser.ts](parser.ts) extracts only unambiguous serving/calorie values.

`POST /api/v1/nutrition-labels/scan` accepts one multipart `image` upload and returns an unsaved draft. Existing authenticated saved-food creation persists the reviewed food under the current user. Neither photos nor raw recognized text are stored or sent to external providers.

OCR runs locally with Tesseract.js, bundled English language data, and Sharp. No credentials or runtime model downloads are required. Production installs include those dependencies automatically. Uploads are limited to 8 MB and 25 megapixels, with one active OCR job per server process, a 45-second deadline, and six scan attempts per user per minute. The client allows 60 seconds for upload and processing. The worker is terminated after success, failure, timeout, or client disconnection, then the scan slot is released.

## Validation

- Backend parser, real OCR, and upload-route tests: `node -r ts-node/register --test test/nutrition-label-parser.test.js test/nutrition-label-scan.test.js test/routes-nutrition-labels.test.js` from `backend/`.
- Client review and cancellation tests: `npm --prefix mobile test -- --runInBand src/nutritionLabel`.
- Browser flow: `npm run test:web:e2e -- e2e/expo-web/nutrition-label.spec.ts`.
