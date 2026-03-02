import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import OpenAI from 'openai';
import { NewsCategory } from 'src/enums/news/news-category.enum';
import { GeneratedNews } from 'types/generated-news';

@Injectable()
export class OpenaiService {
  private readonly logger = new Logger(OpenaiService.name);

  private readonly openai = new OpenAI({
    apiKey: this.requireEnv('OPENAI_API_KEY'),
  });

  // モデルは用途/コストで選んでOK（例）
  // - コスト重視: gpt-4o-mini
  // - もう少し品質: gpt-4o
  private readonly model = 'gpt-4o-mini';

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (!error || typeof error !== 'object') return undefined;
    const maybeError = error as {
      status?: unknown;
      response?: { status?: unknown };
    };
    if (typeof maybeError.status === 'number') return maybeError.status;
    if (typeof maybeError.response?.status === 'number') return maybeError.response.status;
    return undefined;
  }

  /**
   * OpenAIで「JSON配列」をスキーマ強制して返す（Structured Outputs）
   * - これで parseJsonFromModel() のようなゴリゴリパースが不要になる
   */
  private async openaiGenerateNewsJson(prompt: string): Promise<GeneratedNews[]> {
    const timeoutMs = 600_000;
    const maxRetry = 3;

    // GeneratedNews の JSON Schema
    const schema = {
      type: 'json_schema',
      name: 'generated_news_array',
      strict: true,
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'reference_url',
            'reference_name',
            'reference_published_at',
            'header',
            'subheader',
            'summary',
            'body',
            'category',
          ],
          properties: {
            reference_url: { type: 'string' },
            reference_name: { type: 'string' },
            reference_published_at: { type: 'string' }, // ISO文字列想定
            header: { type: 'string' },
            subheader: { type: 'string' },
            summary: { type: 'string' },
            body: { type: 'string' },
            category: { type: 'string' },
          },
        },
      },
    } as const;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await this.openai.responses.create(
          {
            model: this.model,
            input: prompt,
            // Geminiの tools: [{ google_search: {} }] 相当
            // OpenAIは built-in tool の web search を使う
            tools: [{ type: 'web_search' }],
            // Structured Outputs（json_schema）
            text: {
              format: schema,
            },
            temperature: 0.2,
            max_output_tokens: 2048,
          },
          { signal: controller.signal },
        );

        // JS/TS SDKの convenience: output_text が集約テキスト（ドキュメント記載あり）
        // ただし Structured Outputs の場合は「JSON文字列」が入る想定
        const raw = res.output_text ?? '';
        if (!raw.trim()) throw new Error('OpenAI returned empty text');

        // strict json_schema なので基本 JSON.parse 一発でOK
        const parsed = JSON.parse(raw) as GeneratedNews[];
        return parsed ?? [];
      } catch (e: unknown) {
        const status = this.getErrorStatus(e);

        // 429 / 5xx はリトライ
        if (status !== undefined && (status === 429 || (status >= 500 && status < 600)) && attempt < maxRetry) {
          const backoff = 2000 * (attempt + 1);
          this.logger.warn(`OpenAI error (${status}). Retrying in ${backoff}ms...`);
          await this.sleep(backoff);
          continue;
        }

        if (attempt >= maxRetry) throw e;
        await this.sleep(2000 * (attempt + 1));
      } finally {
        clearTimeout(t);
      }
    }

    throw new Error('OpenAI failed after retries');
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }


  async fetchLatestNpbUrls(limit = 30): Promise<string[]> {
    const baseUrl = "https://npb.jp/news/npb_all.html";
    const collected = new Set<string>();
    let page = 1;

    while (collected.size < limit) {
      const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
      const { data: html } = await axios.get<string>(url, { timeout: 10_000 });
      const $ = cheerio.load(html);

      let foundOnThisPage = 0;
      $("a[href]").each((_, el) => {
        if (collected.size >= limit) return;
        const href = $(el).attr("href");
        if (!href) return;
        if (href.includes("/news/detail/")) {
          const abs = href.startsWith("http") ? href : `https://npb.jp${href}`;
          const normalized = abs.trim();
          if (!collected.has(normalized)) {
            collected.add(normalized);
            foundOnThisPage++;
          }
        }
      });

      if (foundOnThisPage === 0) break;
      page++;
    }

    return Array.from(collected).slice(0, limit);
  }

  async fetchLatestMlbUrls(limit = 10): Promise<string[]> {
    const listUrl = "https://www.mlb.com/news";
    const { data: html } = await axios.get<string>(listUrl, {
      timeout: 15_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
      },
    });

    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const out: string[] = [];

    $("article[id]").each((_, el) => {
      if (out.length >= limit) return;
      const id = ($(el).attr("id") || "").trim();
      if (!id) return;
      if (id.startsWith("ad-")) return;
      if (!/^[a-z0-9-]+$/i.test(id)) return;
      const url = `https://www.mlb.com/news/${id}`;
      if (seen.has(url)) return;
      seen.add(url);
      out.push(url);
    });

    return out;
  }

  async fetchLatestHsbUrls(limit = 10): Promise<string[]> {
    const listUrl = "https://www.nikkansports.com/baseball/highschool/news/index.html";
    const { data: html } = await axios.get<string>(listUrl, {
      timeout: 15_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
    });

    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const out: string[] = [];

    $("ul.newslist a[href]").each((_, el) => {
      if (out.length >= limit) return;
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;

      const abs = href.startsWith("http")
        ? href
        : new URL(href, "https://www.nikkansports.com").toString();

      if (!abs.includes("/baseball/highschool/news/")) return;

      const u = new URL(abs);
      u.search = "";
      u.hash = "";
      const normalized = u.toString();

      if (seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    });

    return out;
  }

  async fetchLatestOtherUrls(limit = 10): Promise<string[]> {
    const listUrl = "https://www.sanspo.com/sports/baseball/others/";
    const origin = new URL(listUrl).origin;

    const { data: html } = await axios.get<string>(listUrl, {
      timeout: 15_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      },
    });

    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const out: string[] = [];

    const isArticleUrl = (u: URL) => {
      if (!/(\.|^)sanspo\.com$/i.test(u.hostname)) return false;
      if (!u.pathname.startsWith("/article/")) return false;
      return true;
    };

    $("a[href]").each((_, el) => {
      if (out.length >= limit) return;
      const href = ($(el).attr("href") || "").trim();
      if (!href) return;

      let abs: string;
      try {
        abs = href.startsWith("http") ? href : new URL(href, origin).toString();
      } catch {
        return;
      }

      try {
        const u = new URL(abs);
        u.search = "";
        u.hash = "";
        if (!isArticleUrl(u)) return;

        const normalized = u.toString();
        if (seen.has(normalized)) return;

        seen.add(normalized);
        out.push(normalized);
      } catch {
        return;
      }
    });

    return out;
  }

  async generateNewsFromUrls(
    urls: string[],
    category: NewsCategory,
    referenceName: string,
  ): Promise<GeneratedNews[]> {
    const batches = this.chunk(urls, 1);
    const results: GeneratedNews[] = [];
    const seenUrls = new Set<string>();

    const normalizeUrl = (u: string) => {
      try {
        const x = new URL(u);
        x.search = "";
        x.hash = "";
        return x.toString();
      } catch {
        return u.trim();
      }
    };

    const allowedUrlSet = new Set(urls.map(normalizeUrl));

    const shouldSkip = (item: GeneratedNews) => {
      if (!item?.reference_url) return true;
      if (item.header?.includes('見つかりませんでした') || item.header?.includes('未確認')) return true;
      return false;
    };

    const pushValidated = (item: GeneratedNews) => {
      const ref = normalizeUrl(item.reference_url);
      if (!allowedUrlSet.has(ref)) return false;
      if (!ref || seenUrls.has(ref)) return false;
      if (shouldSkip(item)) return false;

      let publishedAt = item.reference_published_at;
      if (!publishedAt || publishedAt.includes('-00') || isNaN(Date.parse(publishedAt))) {
        publishedAt = new Date().toISOString();
      }

      seenUrls.add(ref);
      results.push({
        ...item,
        category,
        reference_url: ref,
        reference_name: referenceName,
        reference_published_at: publishedAt,
        header: (item.header ?? '').slice(0, 490),
        summary: (item.summary ?? '').slice(0, 490),
      });
      return true;
    };

    const buildPrompt = (targetUrls: string[]) => `
Return ONLY a JSON array. NO introductory text. NO markdown code blocks.
あなたはプロの野球ニュース編集者です。
Web検索ツールを使用して、以下の各URLの記事内容を確認してください。

# 重要
- もしURLに直接アクセスできない場合は、URL内の日付やキーワードを元に検索を行い、該当するニュースを特定してください。
- 事実（スコア、選手名、記録、公式発表内容）のみを抽出してください。
- どうしても内容が特定できないURLについては、その項目を配列に含めないでください。

# 厳守ルール
- 推測・憶測・断定の追加は禁止（記事に書かれている事実のみ）
- 元記事の全文コピーは禁止（要約と再構成のみ）
- 文字数を厳守してください（全角目安）
- 必ずJSON配列だけ返してください。説明は不要。
- 絶対に[cite: ...]や出典の角括弧を出力しない
- 引用・参照の表記は禁止。出力はJSONのみ

# 文字数（全角目安）
- header: 30〜38
- subheader: 40前後
- summary: 120〜180
- body: 200〜500

# 出力形式（必ずこの配列）
[
  {
    "reference_url": "URL（必須）",
    "reference_name": "${referenceName}",
    "reference_published_at": "記事内の日時を優先して必ずISO形式で。（日付が不明な場合は必ず本日（${new Date().toISOString()}）を使用し、決して 00 といった無効な数字を入れないでください。）",
    "header": "…",
    "subheader": "…",
    "summary": "…",
    "body": "…（文末は「。」を使う）",
    "category": "${category}"
  }
]

# 対象URL（新しい順のまま処理）
${targetUrls.map((u) => `- ${u}`).join('\n')}
`;

    const requestOnce = async (targetUrls: string[]) => {
      try {
        const parsed = await this.openaiGenerateNewsJson(buildPrompt(targetUrls));
        return parsed ?? [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`requestOnce failed (treat as empty): ${msg}`);
        return [];
      }
    };

    const requestWithRetry = async (targetUrls: string[], maxRetries = 2) => {
      let attempt = 0;
      const maxAttempts = maxRetries + 1;

      while (attempt < maxAttempts) {
        attempt++;
        if (attempt > 1) await this.sleep(5000 * attempt);

        const parsed = await requestOnce(targetUrls);
        if (parsed.length === 0) {
          if (attempt < maxAttempts) continue;
          break;
        }

        const hasValidItems = parsed.some((item) => {
          const header = item.header ?? '';
          const notFound =
            header.includes('見つかりません') ||
            header.includes('未確認') ||
            header.includes('詳細不明');
          return !notFound;
        });

        if (!hasValidItems) {
          if (attempt < maxAttempts) continue;
          break;
        }

        return parsed;
      }

      this.logger.warn(`Exhausted retries. Returning empty array.`);
      return [];
    };

    for (const batch of batches) {
      if (results.length > 0) await this.sleep(10_000);

      const parsed = await requestWithRetry(batch, 2);
      let added = 0;
      for (const item of parsed) if (pushValidated(item)) added++;

      if (added === 0 && parsed.length === 0) {
        this.logger.warn(`Batch still empty after retries. Per-URL fallback: ${batch.join(', ')}`);
        for (const u of batch) {
          if (seenUrls.has(normalizeUrl(u))) continue;
          await this.sleep(4000);
          const parsedOne = await requestWithRetry([u], 1);
          for (const item of parsedOne) pushValidated(item);
        }
      }
    }

    return results;
  }

  async collectAndGenerateNpbNews(limit = 30): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestNpbUrls(limit);
    return await this.generateNewsFromUrls(urls, NewsCategory.NPB, 'NPB.jp | 日本野球機構');
  }

  async collectAndGenerateMlbNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestMlbUrls(limit);
    return await this.generateNewsFromUrls(urls, NewsCategory.MLB, 'MLB.com | The Official Site of Major League Baseball');
  }

  async collectAndGenerateHsbNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestHsbUrls(limit);
    return await this.generateNewsFromUrls(urls, NewsCategory.HSB, 'nikkansports.com | 日刊スポーツ');
  }

  async collectAndGenerateOtherNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestOtherUrls(limit);
    return await this.generateNewsFromUrls(urls, NewsCategory.OTHER, 'sanspo.com | サンスポ');
  }
}
