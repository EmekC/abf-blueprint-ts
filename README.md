# abfc

abfc is a TypeScript-to-Blueprint compiler for Abiotic Factor mods. You write a mod's Blueprint logic as TypeScript classes, and abfc generates the Blueprint graphs in the mod through a headless Mod Editor backend. The `.ts` files are the source of truth, and the graphs are build artifacts.

Repository: https://github.com/EmekC/abf-blueprint-ts

## Status

Design phase. Nothing is implemented yet.

- [docs/design.md](docs/design.md): goals, workflow, compiler architecture, backend interface, safety rules and open questions.
- [docs/roadmap.md](docs/roadmap.md): the phased plan, starting with a spike that checks the unverified assumptions.

## Requirements

- Windows.
- Abiotic Factor Mod Editor, installed from the Epic Games Launcher.
- The backend: https://github.com/EmekC/abf-mod-editor-mcp (the only supported backend; abfc depends on no other repository).
- Node 24 LTS.

## Not affiliated

abfc is an independent community tool. It is not affiliated with, endorsed by or supported by Deep Field Games, Playstack or mod.io. Nothing derived from Deep Field content is committed to this repository.

## Credits

The backend, abf-mod-editor-mcp, was originally created by theelites11gamer (https://github.com/theelites11gamer/abf-mod-editor-mcp, MIT) and extended with the headless Blueprint tools by DezionDev. abfc depends only on EmekC/abf-mod-editor-mcp.

## License

MIT. See [LICENSE](LICENSE).
