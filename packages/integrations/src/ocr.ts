import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

export type OcrMode = 'disabled' | 'mock' | 'tesseract';
export type OcrPage = { page: number; text: string };
export type OcrResult = { pages: OcrPage[]; parser?: string };
export type OcrProvider = (buffer: Buffer, filename: string) => Promise<OcrResult>;

export class OcrError extends Error {
  constructor(public code: 'OCR_NOT_CONFIGURED' | 'OCR_UNAVAILABLE' | 'OCR_FAILED' | 'OCR_EMPTY', message: string) { super(message); }
}

export function resolveOcrMode(env: Record<string, string | undefined> = process.env): OcrMode {
  const value = env.OCR_MODE?.trim().toLowerCase();
  return value === 'tesseract' || value === 'mock' ? value : 'disabled';
}

function command(command: string, args: string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { Object.assign(error, { stdout, stderr }); reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

function timeoutMs(env: Record<string, string | undefined>) {
  const value = Number(env.OCR_TIMEOUT_MS || 120000);
  return Number.isSafeInteger(value) && value >= 1000 && value <= 900000 ? value : 120000;
}

export function createMockOcrProvider(env: Record<string, string | undefined> = process.env): OcrProvider {
  return async () => {
    const text = env.OCR_MOCK_TEXT?.trim();
    if (!text) throw new OcrError('OCR_NOT_CONFIGURED', 'OCR_MODE=mock 需要提供 OCR_MOCK_TEXT；测试可直接注入 OCR provider。');
    return { pages: text.split('\f').map((page, index) => ({ page: index + 1, text: page.trim() })).filter(page => page.text), parser: 'ocr-mock-v1' };
  };
}

export function createTesseractOcrProvider(env: Record<string, string | undefined> = process.env): OcrProvider {
  const pdftoppm = env.OCR_PDFTOPPM_PATH?.trim() || 'pdftoppm';
  const tesseract = env.OCR_TESSERACT_PATH?.trim() || 'tesseract';
  const language = env.OCR_LANG?.trim() || 'chi_sim+eng';
  const timeout = timeoutMs(env);
  return async (buffer, filename) => {
    const root = await mkdtemp(join(tmpdir(), 'yzgt-ocr-'));
    const source = join(root, basename(filename || 'document.pdf'));
    const prefix = join(root, 'page');
    try {
      await writeFile(source, buffer, { mode: 0o600 });
      try { await command(pdftoppm, ['-png', '-r', '200', source, prefix], timeout); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OcrError('OCR_UNAVAILABLE', '未找到 pdftoppm；请安装 Poppler 或配置 OCR_PDFTOPPM_PATH。');
        throw new OcrError('OCR_FAILED', `PDF 页面渲染失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const images = (await readdir(root)).filter(name => /^page-\d+\.png$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
      if (!images.length) throw new OcrError('OCR_EMPTY', '扫描 PDF 没有可供 OCR 的页面。');
      const pages: OcrPage[] = [];
      for (const [index, image] of images.entries()) {
        try {
          const result = await command(tesseract, [join(root, image), 'stdout', '-l', language, '--psm', '3'], timeout);
          const text = result.stdout.trim();
          if (text) pages.push({ page: index + 1, text });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OcrError('OCR_UNAVAILABLE', '未找到 tesseract；请安装 Tesseract 或配置 OCR_TESSERACT_PATH。');
          throw new OcrError('OCR_FAILED', `第${index + 1}页 OCR 失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!pages.length) throw new OcrError('OCR_EMPTY', 'OCR 未识别出可用文本，请检查扫描质量或语言包。');
      return { pages, parser: `ocr-tesseract-v1:${language}` };
    } finally { try { await rm(root, { recursive: true, force: true }); } catch { /* OCR result/error remains authoritative. */ } }
  };
}

export function resolveOcrProvider(options: { mode?: OcrMode; provider?: OcrProvider; env?: Record<string, string | undefined> } = {}): OcrProvider | null {
  if (options.provider) return options.provider;
  const env = options.env || process.env;
  const mode = options.mode || resolveOcrMode(env);
  if (mode === 'mock') return createMockOcrProvider(env);
  if (mode === 'tesseract') return createTesseractOcrProvider(env);
  return null;
}
