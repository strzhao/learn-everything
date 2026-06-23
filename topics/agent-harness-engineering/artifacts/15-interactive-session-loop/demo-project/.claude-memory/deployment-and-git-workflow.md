---
name: deployment-and-git-workflow
description: Never trigger Vercel deploys unless explicitly asked; watch CI/CD after git push
metadata:
  type: feedback
---

Two workflow constraints from user's global preferences:

1. **Never trigger Vercel deployments unless the user explicitly asks for it.** Vercel deployments are expensive ("vercel 部署太贵了"). Do not push to branches or take actions that would auto-trigger Vercel builds.

2. **After git push, if the project has CI/CD, proactively observe and report the CI/CD result** — don't just push and forget.

3. **`.autopilot/` directory files are shared across team** — must be included in git commits.
