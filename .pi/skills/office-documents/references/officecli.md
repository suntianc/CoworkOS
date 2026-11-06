# OfficeCLI quick reference

These examples describe the open-source `iOfficeAI/OfficeCLI` command named `officecli`. Check `officecli --help` and the installed version before relying on a flag.

## Inspect

```bash
officecli view input.docx --format json
officecli get input.docx /document/body --format json
officecli query input.xlsx 'sheet[name="Sheet1"]' --format json
```

## Edit

```bash
officecli set input.docx /document/body/paragraph[1]/text 'New text'
officecli batch input.xlsx changes.json
```

Use a copied input and keep the original untouched. Prefer `batch` for a group of deterministic changes so the result is easier to review.

## Validate and preview

```bash
officecli validate result.docx --format json
officecli view issues result.docx --format json
officecli render result.docx --output preview/
```

Treat validation and a rendered preview as separate checks: a structurally valid document can still have clipped or unreadable content.

## Python fallback

When `officecli` and LibreOffice are unavailable, use the format library reported by `check_backend.mjs`. This machine may provide `python-docx` even when no general Office CLI is installed:

```bash
python3 -c 'from docx import Document; d=Document("input.docx"); print(len(d.paragraphs))'
```

Python libraries are suitable for creating or editing structured content, but they do not provide a trustworthy rendered preview. Report that limitation and perform XML/package validation plus any available reopen check.
