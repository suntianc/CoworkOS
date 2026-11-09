# Capabilities and migration

[中文](../builtin-capabilities.md) | English

This branch retains the complete CoworkOS orchestration chain: Main, Coordinator Runtime, Subagents, Jobs, long-term goals, monitoring, human questions, workspaces, memory, checkpoints and session recovery. Generic files and attachments, image inspection, search, Computer Use and generic MCP interfaces remain available.

Under the [phase plan](../development-phases.md) (Chinese), P4.5 removes the UI entry for long-term goals and monitoring and keeps only their backend capability and interfaces; how the product uses them will be planned separately.

Removed capabilities:

- Blender workbench, engine, installer, Blender Harness, domain tools and skills.
- CAD workbench, JSCAD/CadQuery kernels, CAD/FreeCAD Harness, native viewers, domain tools and skills.
- PPTist, OfficeHarness, PPTX/HTML deck authoring skills, `review_slides`, editor assets and their build dependencies.
- Scientific tools, scientific environment installation, and the specialized Office creation skill. Projects can use their own Python environments.
- Background component downloads, component settings, credential IPC, component CLI commands and separate component packaging/publication.

Generic attachment extraction still supports existing Office documents. User-configured MCP servers and custom skills retain their existing discovery mechanism.

## Existing data

Product startup does not automatically delete project files or task records. Existing CAD, Blender and presentation application resources cannot be edited by this branch; use the upstream version or native applications and keep the original projects. Start with a separate data directory to avoid restoring old application tabs into a new workspace.

## Development and verification

```sh
npm ci
npm run build
npm run ui
# Desktop development
npm run desktop
# Full deterministic verification
npm run verify:full
```

Build and installation no longer download or generate CAD, Blender or PPTist resources. Release notes describe their historical versions; this page and the source registries define the current capabilities.

The text and Markdown editor, its dedicated MCP server, tools and UI have also been removed. The built-in application catalog is empty. Agents use generic file tools for ordinary text and Markdown files. Existing text resources remain on disk and can be opened with an external editor. Contract fixtures under `test/fixtures/application-contract/` are test-only and excluded from packages.
