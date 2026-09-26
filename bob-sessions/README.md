# Bob sessions

Screenshots of the IBM Bob sessions used while building Traceon, included as
part of the submission requirements.

## Contents

| File | What it shows |
|---|---|
| [01-plan-architecture-and-tech-stack.png](01-plan-architecture-and-tech-stack.png) | Bob plans the prototype: a single self-contained HTML file with vanilla JavaScript and CSS, no build step, interactive routing between sections |
| [02-create-project-data-and-model.png](02-create-project-data-and-model.png) | Bob creates the project data and Project Model and writes the first version of `traceon.html` (CSS foundation) |
| [03-build-app-shell-and-verify.png](03-build-app-shell-and-verify.png) | Bob builds the application shell and navigation, adds the JavaScript in chunks, then checks the file's structure and opens it to confirm it renders |
| [04-user-workflow-summary-part-1.png](04-user-workflow-summary-part-1.png) | Bob's summary of the finished workflow, steps 1–7: Connect, Loading, Overview, Project Map, Onboarding, Maintenance, Testing |
| [05-user-workflow-summary-part-2.png](05-user-workflow-summary-part-2.png) | Summary continued, steps 8–12: Generate Test, Change Impact, Release, Reports, Developer Impact |
| [06-architecture-notes-and-url-classification-fix.png](06-architecture-notes-and-url-classification-fix.png) | Bob documents the architecture (state variables, `activeUrlProfile` as the central data model, page init functions and render caching) and fixes URL classification by matching the longest profile first |
| [07-health-fix-connect-panels-and-github-scan.png](07-health-fix-connect-panels-and-github-scan.png) | Fix for null health scores rendering as red, the multi-panel connect screen, and how the GitHub scan reads files and checks dependencies |
| [08-fix-bootstrap-and-real-repo-pages.png](08-fix-bootstrap-and-real-repo-pages.png) | Bob fixes the page bootstrap and `selectDemo()`, then updates Maintenance, Testing Gaps, Generate Test and Change Impact to handle real repositories |
| [09-dynamic-onboarding-for-real-repos.png](09-dynamic-onboarding-for-real-repos.png) | Onboarding tabs switched from hardcoded HTML to content generated from the analysed repository, with caching reset when switching projects |
| [10-verify-onboarding-and-syntax-check.png](10-verify-onboarding-and-syntax-check.png) | Bob verifies the onboarding render caching, opens the page for a visual spot-check and checks the large template literals for syntax errors |

## Naming

Name each screenshot so the files sort in the order the work happened:

```
01-short-description.png
02-short-description.png
03-short-description.png
```

For example `01-project-setup.png`, `02-github-oauth.png`, `03-ui-redesign.png`.
PNG or JPG both work.

## Adding screenshots

**On GitHub (no tools needed):** open this `bob-sessions` folder on
github.com → **Add file** → **Upload files** → drag in the screenshots →
**Commit changes**.

**With git:** copy the images into this folder, then run

```bash
git add bob-sessions
git commit -m "Add Bob session screenshots"
git push
```
