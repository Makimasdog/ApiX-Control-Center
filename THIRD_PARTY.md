# Third-party components

ApiX Control Center is an independent repository. It does not vendor the Pi or Codex source code.

- [Pi](https://github.com/earendil-works/pi) is an optional external runtime used through its JSONL RPC interface. Pi is distributed under the MIT License, Copyright (c) 2025 Mario Zechner. Its license and notices remain with the Pi installation.
- [Codex CLI](https://github.com/openai/codex) is an optional external runtime used through `codex exec --json`. Its terms and license remain with the Codex installation.

The first independent ApiX revision was extracted from the ApiX work on `Makimasdog/ApiX` at commit `44fb039de`. That repository is a Pi fork and remains available as the development provenance for earlier ApiX phases. This repository contains only the ApiX control center, its tests, and its documentation.
