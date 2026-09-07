You are fixing an urgent real-user regression on existing draft MR !56.

Work only in `/home/dev/consultatie-pdf-rasterless`, existing branch `perf/pdf-contentstream-geometry`, starting
from clean pushed head `118e3b3`. Henk generated a PDF from the live preview and still sees no yellow highlighting
and no comments, even though the current generated-PDF tests pass. Treat his observation as authoritative and
prove the failure yourself before editing.

Reproduce the exact end-user flow against
`consultatie-perf-pdf-contentstream-geometry.simulatie.datastelsel.nl` using existing local preview credentials,
fixtures, browser automation, and scripts where available. Download the produced PDF and inspect/open/render it
with a real PDF viewer/rendering engine, not only pdfcpu dictionary parsing. Determine why annotations that tests
claim exist are invisible or unusable in an actual viewer. Check the full PDF annotation contract: subtype,
appearance streams, flags, colors/opacity, rect/quadpoints, popup/parent linkage, page references, contents,
incremental serialization, and viewer compatibility. Compare with the previously working raster-generated output
if useful.

Fix the root cause while preserving comment contents, correct passage geometry, fail-closed behavior, and the
rasterless performance improvement. Add a durable regression that would fail on `118e3b3` and covers the visible
viewer outcome (rendered yellow markings and accessible comments), plus retain structural content/geometry tests.
Run focused tests and proportionate full race/vet/lint/nilaway/build checks. Remove all downloaded PDFs/debug
artifacts from the repository. Commit and push the same branch to update draft MR !56.

Do not run review-loop, merge, un-draft, or touch unrelated work. Report: exact reproduction, viewer/tool used,
root cause explaining the false-green tests, test that fails before/passes after, checks, commit, and MR URL.
