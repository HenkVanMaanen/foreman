# Task: review Consultatie open issues and comment with tiny proposals

Authoritative instruction: Henk Telegram msg 333051199 asks us to check GitLab issues for Consultatie, ask
lettered questions with our recommendation when unclear, and post genuinely small proposals as issue comments.

Repository/project: GitLab project id 83546554, likely local repo `/home/dev/projects/gitlab.com/datastelsel.nl/federatief/simulation/consultatie`.

Do this autonomously:

1. List every currently open GitLab issue in project 83546554 and read its full description plus existing comments.
2. For each issue, decide whether the requested outcome is clear.
3. Post exactly one concise GitLab comment per open issue:
   - If clear: a short Dutch summary of the smallest sensible implementation slice you would propose.
   - If unclear: concise lettered choices (A/B/C only as needed), state which letter you recommend and why in one
     sentence, and keep any implementation proposal conditional and tiny.
4. Do not write code, create branches/MRs, edit issue metadata, or perform any mutation beyond these requested
   comments. Do not claim investigation or feasibility that the issue evidence does not support.
5. Avoid duplicating a substantially identical existing comment; if foreman already commented, report it instead.
6. Return a compact inventory: issue number/title, clarity judgement, exact comment posted, and full issue URL.

Use `glab` and project id 83546554. Comments are explicitly authorized by the human. Keep proposals deliberately
small and reviewable; no broad redesigns, opportunistic cleanup, or multi-phase roadmaps.
