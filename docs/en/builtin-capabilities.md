# Capabilities and migration

[中文](../builtin-capabilities.md) | English

This branch retains the complete CoworkOS orchestration chain: Main, Coordinator Runtime, Subagents, Jobs, human questions, workspaces, checkpoints and session recovery. Generic files and attachments, image inspection, search and Computer Use remain available.

Removed capabilities:

- User memory (including manual memory), automatic learning and project experience: storage, HTTP routes, Pi tools, UI entries and dedicated tests are gone, and the requirement ledger now supplies project context.
- Applications and the workbench: application registry, instances, shared resources and the revision protocol, application binding, adapters, MCP hosting, the text and Markdown editor, workbench tabs and their UI entries.
- Blender workbench, engine, installer, Blender Harness, domain tools and skills.
- CAD workbench, JSCAD/CadQuery kernels, CAD/FreeCAD Harness, native viewers, domain tools and skills.
- PPTist, OfficeHarness, PPTX/HTML deck authoring skills, `review_slides`, editor assets and their build dependencies.
- Scientific tools, scientific environment installation, and the specialized Office creation skill. Projects can use their own Python environments.
- Background component downloads, component settings, credential IPC, component CLI commands and separate component packaging/publication.

Generic attachment extraction still supports existing Office documents; custom skills retain their existing discovery mechanism. Web search still uses the built-in Exa provider.

## Existing data

Product startup does not automatically delete project files or task records. Old application instance, resource and tab files stay on disk but are no longer read, and existing CAD, Blender and presentation resources cannot be opened in the UI; use the upstream version or native applications and keep the original projects. Start with a separate data directory when upgrading.

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

Build and installation no longer download or generate CAD, Blender or PPTist resources. Release notes describe their historical versions; this page and the source define the current capabilities.

Applications and the workbench were removed in P4.6. Agents use generic file tools for ordinary text and Markdown files; attachments are read through uploads, `read_attachment`, preview and download, and deliverables are published with `publish_artifact` and used from the work entry as a read-only preview, a download, or the desktop "open with the system default app" action.
