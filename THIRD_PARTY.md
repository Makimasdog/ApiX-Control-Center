# Third-party components

ApiX Control Center is an independent repository. It does not vendor the Pi or Codex source code.

- [Pi](https://github.com/earendil-works/pi) is an optional external runtime used through its JSONL RPC interface. Pi is distributed under the MIT License, Copyright (c) 2025 Mario Zechner. Its license and notices remain with the Pi installation.
- [Codex CLI](https://github.com/openai/codex) is an optional external runtime used through `codex exec --json` or its stdio App Server protocol. Its terms and license remain with the Codex installation.
- [Claw Empire](https://github.com/GreenSheep01201/claw-empire) informed the manager overview's information architecture (dashboard, task board, agent details and review flow). The reference project is Apache-2.0 licensed. No Claw Empire source code or visual assets are included here.

The first independent ApiX revision was extracted from the ApiX work on `Makimasdog/ApiX` at commit `44fb039de`. That repository is a Pi fork and remains available as the development provenance for earlier ApiX phases. This repository contains only the ApiX control center, its tests, and its documentation.

- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript), pinned at 0.3.314, is a runtime dependency. Copyright Anthropic PBC; proprietary terms apply, see its distributed LICENSE.md/README.md and [legal agreements](https://code.claude.com/docs/en/legal-and-compliance). The SDK and platform packages retain their license notices in node_modules and desktop dependencies. Claude Code remains a separately installed runtime; ApiX does not copy local login files. No emperor-agent source or assets were copied.
