import { extname, resolve, sep } from 'node:path';
import { OcrError, resolveOcrProvider, type OcrMode, type OcrProvider } from './ocr';
export type Locator = { page?: number; paragraph?: number };
export type ParsedClause = { text: string; locator: Locator; clause_number?: string };
export type ParsedDocument = { text: string; clauses: ParsedClause[]; parser: string };
export type ParseDocumentOptions = { ocrMode?: OcrMode; ocrProvider?: OcrProvider; env?: Record<string, string | undefined> };
export class IntegrationError extends Error {
  constructor(public code: string, message: string, public status = 422) { super(message); }
}
export function clause(text: string, locator: Locator): ParsedClause {
  const number = text.match(/^(第[零一二三四五六七八九十百\d]+条|\d+(?:\.\d+)*[、.．]?)/)?.[1];
  const financialNumber = /^\d+\.\d+\s*(?:万元|元|%|％)/.test(text);
  return { text, locator, ...(number && !financialNumber ? { clause_number: number } : {}) };
}
export function paragraphs(text: string): ParsedClause[] {
  return text.replace(/\r\n?/g, '\n').split(/\n+/).map(t => t.trim()).filter(Boolean).map((t, i) => clause(t, { paragraph: i + 1 }));
}
function ocrParagraphs(page: number, text: string): ParsedClause[] {
  return text.replace(/\r\n?/g, '\n').split(/\n+/).map(t => t.trim()).filter(Boolean).map((t, i) => clause(t, { page, paragraph: i + 1 }));
}
const structuredLineStart = /^(?:第[零一二三四五六七八九十百\d]+条|\d+(?:\.\d+)+\s|[（(]\s*[一二三四五六七八九十\d]+\s*[）)]|[一二三四五六七八九十]+[、.．])/;
const terminalLine = /[。！？；;：:]$/;
/** Join visual PDF lines back into logical paragraphs while preserving page/paragraph locators. */
export function mergePdfLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const raw of lines.map(line => line.trim()).filter(Boolean)) {
    // Bare page numbers are headers/footers in the supplied agreements, not clauses.
    if (/^\d{1,3}$/.test(raw) && !result.length) continue;
    const previous = result.at(-1);
    if (!previous || structuredLineStart.test(raw) || terminalLine.test(previous)) result.push(raw);
    else result[result.length - 1] = previous + raw;
  }
  return result;
}
export async function parseDocument(buffer: Buffer, filename: string, options: ParseDocumentOptions = {}): Promise<ParsedDocument> {
  const extension = extname(filename).toLowerCase();
  if (extension === '.doc') throw new IntegrationError('UNSUPPORTED_DOCUMENT', '旧版 DOC 暂不支持，请转换为 DOCX 或文字型 PDF。');
  if (!['.pdf', '.docx', '.txt', '.md'].includes(extension)) throw new IntegrationError('UNSUPPORTED_DOCUMENT', '仅支持 PDF、DOCX、TXT 和 Markdown 文件。');
  if (!buffer.length) throw new IntegrationError('EMPTY_DOCUMENT', '文件为空，请重新上传。');
  if (extension === '.txt' || extension === '.md') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
    catch { throw new IntegrationError('INVALID_ENCODING', '文本不是有效的 UTF-8，请转换编码后重新上传。'); }
    if (text.includes('\0') || !text.trim()) throw new IntegrationError('INVALID_TEXT', '文件内容与文本格式不匹配，或没有可读取的文本。');
    return { text, clauses: paragraphs(text), parser: 'utf8-v1' };
  }
  if (extension === '.docx') {
    if (buffer.subarray(0, 2).toString() !== 'PK') throw new IntegrationError('CORRUPT_DOCUMENT', 'DOCX 文件损坏、加密或格式不匹配，请另存为未加密 DOCX 后重试。');
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      if (!result.value.trim()) throw new IntegrationError('SCANNED_DOCUMENT', 'DOCX 没有可读取文本；当前 OCR 仅支持扫描 PDF，请转换为可复制文字的 DOCX 或 PDF。');
      return { text: result.value, clauses: paragraphs(result.value), parser: 'mammoth-1.9.1' };
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      throw new IntegrationError('CORRUPT_DOCUMENT', 'DOCX 文件损坏或加密，无法读取。请另存为未加密 DOCX 后重试。');
    }
  }
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new IntegrationError('CORRUPT_DOCUMENT', 'PDF 文件损坏或格式不匹配，请重新导出后上传。');
  if (/\/Encrypt\b/.test(buffer.toString('latin1'))) throw new IntegrationError('ENCRYPTED_DOCUMENT', 'PDF 已加密，请提供未加密的文件。');
  let document: any;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    document = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false,
      cMapUrl: resolve('node_modules/pdfjs-dist/cmaps') + sep, cMapPacked: true,
      standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + sep,
      useSystemFonts: true, verbosity: 0 }).promise;
    const clauses: ParsedClause[] = [];
    for (let page = 1; page <= document.numPages; page++) {
      const content = await (await document.getPage(page)).getTextContent();
      const lines: string[] = []; let line = ''; let lastY: number | null = null;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform?.[5];
        if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 3 && line.trim()) { lines.push(line.trim()); line = ''; }
        line += item.str;
        lastY = y ?? lastY;
        if (item.hasEOL && line.trim()) { lines.push(line.trim()); line = ''; }
      }
      if (line.trim()) lines.push(line.trim());
      clauses.push(...mergePdfLines(lines).map((t, i) => clause(t, { page, paragraph: i + 1 })));
    }
    if (!clauses.length) {
      const provider = resolveOcrProvider({ mode: options.ocrMode, provider: options.ocrProvider, env: options.env });
      if (!provider) throw new IntegrationError('SCANNED_DOCUMENT', 'PDF 没有可读取的文本，可能是扫描件；请配置 OCR_MODE=mock（演示）或 OCR_MODE=tesseract 后重试。');
      try {
        const ocr = await provider(buffer, filename);
        const ocrClauses = ocr.pages.flatMap(page => ocrParagraphs(page.page, page.text));
        if (!ocrClauses.length) throw new OcrError('OCR_EMPTY', 'OCR 未识别出可用文本，请检查扫描质量或语言包。');
        return { text: ocrClauses.map(c => c.text).join('\n'), clauses: ocrClauses, parser: ocr.parser || 'ocr-v1' };
      } catch (error) {
        if (error instanceof IntegrationError) throw error;
        if (error instanceof OcrError) throw new IntegrationError(error.code, error.message);
        throw new IntegrationError('OCR_FAILED', `OCR 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { text: clauses.map(c => c.text).join('\n'), clauses, parser: 'pdfjs-dist-4.10.38' };
  } catch (error: any) {
    if (error instanceof IntegrationError) throw error;
    if (error?.name === 'PasswordException') throw new IntegrationError('ENCRYPTED_DOCUMENT', 'PDF 已加密，请提供未加密的文件。');
    throw new IntegrationError('CORRUPT_DOCUMENT', 'PDF 文件损坏或无法解析，请重新导出文字型 PDF 后重试。');
  } finally { if (document) await document.destroy(); }
}
