# Task: fully retire legacy Radar Rust resources (option B)

Authority: Henk Telegram msgs 333051215 and 333051218. Henk explicitly chose option B: remove the now-unrouted
legacy Rust version completely, including its PVC and physical database `standaard_radar_rust`.

Worktree `/home/dev/worktrees/simulation-radar-rust-retirement`, branch `cleanup/radar-rust-retirement`, current
Simulation main. Project id 61564605.

Use a fresh, evidence-driven implementation. Inspect the merged !447 state and remove only legacy Rust GitOps
resources and now-unused Rust-only references/secrets if proven unused. Make the destructive consequences explicit
in the MR. Preserve the active Go release, canonical route, Go database `standaard_radar_go`, claim
`standaard-radar-go-data`, and suspended future canonical replacement exactly. Update validation/tests so stale Rust
resources cannot silently remain and Go identities/routes are pinned. Compare rendered overlays before/after and
enumerate exactly which resource identities disappear. Run manifest/YAML/shell/secret validation, commit, push, and
open a DRAFT MR. No final review-loop, merge, Flux/kubectl, or live mutation. Write a detailed worker note/result.
