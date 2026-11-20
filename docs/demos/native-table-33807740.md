# Native table — exact-source synthetic demonstration

![Full export and source detail](<native-table-33807740.gif>)

- Recorded product source: commit `3380774002a356633ca2405fba6624b8a9c1baa5`, tree `e77c1630e0b115ae9ab725b64f82b97e7dace014`.
- Mode: headless Chromium video of the actual built Web UI against a real, isolated market server and worker; synthetic identity and rows. No business API or download-anchor interception.
- Demonstrated: an actual browser CSV download of all 4,833 matching data rows despite the 50-row display; an actual filtered download of 1,650 matches; same-context original-row details, explicit absence of original evidence, a narrow viewport, and an explicit refusal for an already-existing unauthorized synthetic viewer.
- The CSV files were parsed and checked, including fixed batch/version filters, first/last IDs and current filter values. The GIF is a demonstration, not proof that a spreadsheet application executed no formula.
- GIF: 8,484,740 bytes; SHA-256 `c2f7760c354b1fa9c6ab8bce0f5ccd7c276368718d79023f559cfa1fe62d62e7`.
- Recorded all-match CSV: 236,551 bytes, 4,833 data rows; SHA-256 `db95fed5fff53fb5d8b834945bbfec13ce6b99a67e13534a81bceda957ced705`.
- Recorded filtered CSV: 86,950 bytes, 1,650 data rows; SHA-256 `0b8d49472d0c01c5ef28fe8ebb2af79a8dbbe70b07ca48e2193d36b326af8527`.

The only recording-runner adaptations selected a task-owned browser recording script and supplied an existing second synthetic session. Product source was not changed. The original video, capture observations and downloaded CSVs remain in the project task artifacts; the demonstration contains no real financial records, real source attachments or credentials.

This document and GIF are an evidence-only supplement to the reviewed product commit. They do **not** mean that the integrated release, existing smoke-test failure, production release HOLD, deployment/rollback identity or business-user acceptance has passed. The capability is **NOT_PUBLISHED / NOT_FIXED_IN_PRODUCTION** until those separate gates are met.
