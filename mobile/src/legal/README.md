# Public legal content and distribution disclosures

[publicLegalContent.ts](publicLegalContent.ts) is the single source for public privacy
and account-deletion copy; pages and native legal handoffs render/link it. Do not
copy policy prose into screen components or release worksheets. Backend export and
deletion semantics live in [backend](../../../backend/README.md#portability-and-deletion).

When preparing store declarations, inspect the exact final phone/Wear bundles and
their transitive SDK behavior, current provider agreements, deployed public pages,
and actual runtime traffic. Source facts alone cannot establish Play approval,
provider sharing classification, monitored deletion mailboxes or deployed TLS.
Use the current [Health Connect publishing guidance](https://developer.android.com/health-and-fitness/health-connect/publish)
and [Data Safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469).
Keep submitted forms and release-specific evidence with the release/PR, outside Git.

Review these data boundaries when changing the disclosures: optional avatar/label
image uploads and in-memory OCR; Lose It archive processing; food queries/barcodes
sent to configured providers; optional Expo push; read-only Health Connect source
records and aggregates; device-scoped credentials and offline queues; user-selected
export sharing; and backup/log retention after deletion. Barcode frames stay on
device, whereas label images are uploaded for local server OCR. Activity remains
observational and the watch does not collect sensors. A dependency or permission
change requires renewed inspection, not reuse of an old checklist's answers.
