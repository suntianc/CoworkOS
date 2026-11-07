#!/usr/bin/env python3
"""Read a bounded section of a local document; never modify the original."""
import sys, json, os
path, offset, limit, page, render = sys.argv[1:]
offset, limit, page = int(offset), min(int(limit), 20000), int(page)
extension = os.path.splitext(path)[1].lower()
parts = []
try:
    if extension == '.pdf':
        if render == '1':
            import fitz, base64
            document = fitz.open(path)
            if page < 1 or page > len(document): raise ValueError('PDF 页码超出范围')
            rect = document[page-1].rect
            scale = min(1.5, 1600/max(rect.width, rect.height, 1))
            data = document[page-1].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).tobytes('png')
            print(json.dumps({'image':base64.b64encode(data).decode('ascii'), 'mimeType':'image/png', 'page':page, 'pages':len(document)})); sys.exit(0)
        try:
            from pypdf import PdfReader
            document = PdfReader(path)
            count = len(document.pages)
            selected = [page-1] if page else range(count)
            for index in selected:
                if index < 0 or index >= count: raise ValueError('PDF 页码超出范围')
                parts.append('[第 %d 页]\n%s' % (index+1, document.pages[index].extract_text() or '（此页无可提取文字，可用 render=true 查看页面）'))
                if sum(map(len,parts)) > offset+limit: break
        except ImportError:
            import fitz
            document = fitz.open(path); count = len(document)
            selected = [page-1] if page else range(count)
            for index in selected:
                parts.append('[第 %d 页]\n%s' % (index+1, document[index].get_text() or '（此页无可提取文字，可用 render=true 查看页面）'))
                if sum(map(len,parts)) > offset+limit: break
    else:
        import zipfile
        with zipfile.ZipFile(path) as archive:
            if sum(item.file_size for item in archive.infolist()) > 128*1024*1024: raise ValueError('文档解压后过大')
        if extension == '.docx':
            from docx import Document
            document = Document(path)
            parts = [paragraph.text for paragraph in document.paragraphs]
            for table in document.tables:
                parts.append('[表格]\n'+'\n'.join('\t'.join(cell.text for cell in row.cells) for row in table.rows))
        elif extension == '.pptx':
            from pptx import Presentation
            document = Presentation(path)
            for index, slide in enumerate(document.slides):
                if page and index+1 != page: continue
                text = []
                for shape in slide.shapes:
                    if shape.has_text_frame: text.append(shape.text)
                    if shape.has_table: text.extend('\t'.join(cell.text for cell in row.cells) for row in shape.table.rows)
                parts.append('[幻灯片 %d]\n%s' % (index+1, '\n'.join(text)))
        elif extension == '.xlsx':
            from openpyxl import load_workbook
            document = load_workbook(path, read_only=True, data_only=False)
            length = 0
            for sheet in document:
                parts.append('[工作表 %s]' % sheet.title)
                for index, row in enumerate(sheet.iter_rows(values_only=True)):
                    line = '[行 %d] %s' % (index+1, '\t'.join('' if v is None else str(v) for v in row))
                    parts.append(line); length += len(line)+1
                    if length > offset+limit: break
                if length > offset+limit: break
            document.close()
    text = '\n\n'.join(parts)
    excerpt = text[offset:offset+limit]
    print(json.dumps({'text':excerpt, 'offset':offset, 'nextOffset':offset+len(excerpt) if offset+len(excerpt)<len(text) else None, 'page':page or None}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error':'文档读取失败：'+str(error)+'。请检查本机文档解析依赖，原文件已保留。'}, ensure_ascii=False))
    sys.exit(1)
