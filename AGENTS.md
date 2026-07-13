# Repository Instructions

- Never auto-commit at the end of your turn unless the user asked you to.
- Use Conventional Commits for commit messages.
- Keep each human-facing hudhook POC test case available through its own launcher under `poc/hudhook-imgui-overlay/scripts/test-cases`; parameterized runners may remain internal automation.
- The demo Steam auto-attacher must attempt every detected `.exe` under `steamapps` independently; do not add executable plausibility heuristics or helper-name exclusions.
