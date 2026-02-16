import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';

export type NewsCategory = 'NPB' | 'MLB' | 'HS' | 'OTHER';

export interface GeneratedNews {
  reference_url: string;
  reference_name: string;
  reference_published_at: string; // ISO推奨（無ければ""）
  header: string;                 // 全角30〜38
  subheader: string;              // 全角40前後 or ""
  summary: string;                // 全角120〜180
  body: string;                   // 200〜600
  category: NewsCategory;
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
  }[];
}

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  // 公式例に合わせたモデル指定（必要ならここだけ変える）
  private readonly endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent';

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  private async geminiGenerateText(prompt: string): Promise<string> {
    const apiKey = this.requireEnv('GEMINI_API_KEY');

    // Node fetch(undici) タイムアウト対策
    const controller = new AbortController();
    const timeoutMs = 600_000;
    const t = setTimeout(() => controller.abort(), timeoutMs);

    // 503/429 を軽くリトライ（最大2回）
    const maxRetry = 2;

    try {
      for (let attempt = 0; attempt <= maxRetry; attempt++) {
        try {
          const res = await fetch(this.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': apiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              // ★ url_context 等は使わない（Browse機能はモデル/環境依存で落ちる）
              generationConfig: { temperature: 0.2 },
            }),
            signal: controller.signal,
          });

          if (!res.ok) {
            const text = await res.text().catch(() => '');
            // 429/503だけリトライ
            if ((res.status === 429 || res.status === 503) && attempt < maxRetry) {
              const backoff = 800 * (attempt + 1);
              this.logger.warn(`Gemini ${res.status}. retry in ${backoff}ms`);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            throw new Error(`Gemini API error: ${res.status} ${text}`);
          }

          const data = (await res.json()) as GeminiResponse;
          const out =
            data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

          if (!out.trim()) throw new Error('Gemini returned empty text');
          return out;
        } catch (e: unknown) {
          // Abort も含めて、最後の試行で投げる
          if (attempt >= maxRetry) throw e;
          const backoff = 800 * (attempt + 1);
          const errorMsg = e instanceof Error ? e.message : String(e);
          this.logger.warn(`Gemini fetch failed. retry in ${backoff}ms: ${errorMsg}`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      throw new Error('Gemini failed after retries');
    } finally {
      clearTimeout(t);
    }
  }

  private parseJsonFromModel<T>(raw: string): T {
    // ```json や ``` を除去
    const cleaned = raw.replace(/```json/gi, '```').replace(/```/g, '').trim();

    const firstBrace = Math.min(
      ...['{', '['].map((c) => cleaned.indexOf(c)).filter((i) => i >= 0),
    );
    const lastBrace = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));

    const slice =
      firstBrace >= 0 && lastBrace >= 0 ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned;

    return JSON.parse(slice) as T;
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  /**
   * ★ URL一覧取得は Gemini にやらせない（ここが遅延/timeout/400の根）
   * NPBニュース一覧HTMLから detail URL を自前で抽出する
   */
  async fetchLatestNpbUrls(limit = 30): Promise<string[]> {
    const listUrl = 'https://npb.jp/news/npb_all.html';
    const { data: html } = await axios.get<string>(listUrl, { timeout: 10_000 });

    const $ = cheerio.load(html);

    // npb.jp 側のリンク構造に合わせて抽出（必要ならここを調整）
    const urls: string[] = [];

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      // 例: /news/detail/xxxxx.html みたいな形式を拾う想定
      if (href.includes('/news/detail/')) {
        const abs = href.startsWith('http') ? href : `https://npb.jp${href}`;
        urls.push(abs);
      }
    });

    // 重複排除＆新しい順にしたい場合は、DOM順が新しい順ならそのまま
    const unique = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));

    return unique.slice(0, limit);
  }

  /**
   * URL一覧を Gemini に渡して記事を生成（20件ずつ推奨）
   * ※ここは Gemini 依存なので遅い。seedをSSRで待たないようにする。
   */
  async generateNewsFromUrls(
    urls: string[],
    category: NewsCategory,
    referenceName: string,
  ): Promise<GeneratedNews[]> {
    const batches = this.chunk(urls, 10); // ←一旦10に下げると安定しやすい
    const results: GeneratedNews[] = [];

    for (const batch of batches) {
      const prompt = `
あなたはプロのニュース編集者です。
以下のURLの記事をそれぞれ読み取り、事実に基づいて「要約」し、その要約を元に「再生成したニュース」を作ってください。

# 厳守ルール
- 推測・憶測・断定の追加は禁止（記事に書かれている事実のみ）
- 誇張禁止、煽り禁止
- 元記事の全文コピーは禁止（要約と再構成のみ）
- 出力は必ずJSONのみ（コードフェンス不要、余計な文章禁止）

# 文字数（全角目安）
- header: 30〜38
- subheader: 40前後（不要なら空文字 ""）
- summary: 120〜180
- body: 200〜600

# 出力形式（必ずこの配列）
[
  {
    "reference_url": "URL（必須）",
    "reference_name": "${referenceName}",
    "reference_published_at": "記事内の日時を優先してISO形式で（無ければ空文字）",
    "header": "…",
    "subheader": "… or \\"\\"",
    "summary": "…",
    "body": "…",
    "category": "${category}"
  }
]

# 対象URL（新しい順のまま処理）
${batch.map((u) => `- ${u}`).join('\n')}
`;
      console.log("Prompt for Gemini:", prompt);

      const text = await this.geminiGenerateText(prompt);
      console.log("Raw text from Gemini:", text);
      const parsed = this.parseJsonFromModel<GeneratedNews[]>(text);
      console.log("Parsed Gemini output:", parsed);

      for (const item of parsed ?? []) {
        if (!item?.reference_url || !item?.header || !item?.summary || !item?.body) continue;
        results.push({
          ...item,
          category,
          reference_name: referenceName,
        });
      }
    }

    console.log(`Generated ${results.length} news items from Gemini.`);

    return results;
  }

  /** まとめ：NPB 取得→生成 */
  async collectAndGenerateNpbNews(limit = 30): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestNpbUrls(limit);
    console.log("Fetched URLs:", urls);
    return await this.generateNewsFromUrls(urls, 'NPB', 'NPB.jp | 日本野球機構');
  }
}
