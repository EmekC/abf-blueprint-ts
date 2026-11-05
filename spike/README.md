Throwaway Phase 0 spike code (probes P1-P9). Nothing here ships; nothing here goes into a mod folder.
Results and decisions: docs/spike-results.md. Raw outputs (gitignored, may hold game-derived names): spike/out/.
Machine paths come from env vars or args: ABFC_SPIKE_BACKEND_DIR (backend worktree), ABFC_SPIKE_MCP_DIR (main MCP checkout), ABFC_SPIKE_MOD_DIR (real mod dir, read-only).
Generated specs and IR (anything built from the game's own export text or pin lists: raw-graph, raw-wired2, map-raw, UpdateTarget.ir.json, apply.spec.json) live in spike/out/ (gitignored); the make_*.mjs generators write there. A relative "spec_file" in a *.args.json is resolved by spike/mcp_call.py against the repo root.
