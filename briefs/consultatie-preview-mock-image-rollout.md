# Consultatie MR !51 — fix stale mock-IdP preview image

Work in `/home/dev/consultatie-pdf-performance` on existing branch `perf/comment-pdf-1000` and existing draft MR !51.

Live reproduction after green pipeline 2808205755: the app preview is new, but the mock IdP picker still shows `Mock Gebruiker` / `gebruiker@mock.local`, not the committed `PDF Testgebruiker`. Root cause identified in deployment machinery: `build-mock-idp` publishes mutable `${CI_COMMIT_REF_SLUG}`, while `deploy/previews/preview.sh` renders the same mutable tag into an otherwise unchanged Deployment pod template. Kubernetes therefore does not roll the mock-idp pod and may retain the old image.

Implement the smallest robust fix:

- Publish the branch preview mock-idp image under an immutable per-commit tag consistent with the preview overlay (prefer `${CI_COMMIT_REF_SLUG}-${CI_COMMIT_SHORT_SHA}`).
- Render that exact immutable tag in the mock-idp Deployment, so each commit changes the pod template and triggers rollout.
- Preserve the documented default-branch/permanent acceptance behavior if applicable; do not break `mock-idp:main`. Carefully inspect CI rules and adjust comments/docs/tests.
- Add or update automated shell/render tests proving the build tag and rendered deployment tag stay aligned and change per commit. Run focused quick checks plus `git diff --check`/shell checks.
- Commit and push to the existing branch/MR. Do not open another MR. Do not run review-loop. Record exact validation and any CI caveat in `notes/tasks/consultatie-pdf-performance.md`, but do not overwrite foreman’s existing history.
- Human needs this live urgently; keep scope strictly to immutable mock-idp rollout.

