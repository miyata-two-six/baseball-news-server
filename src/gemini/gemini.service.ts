import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { NewsCategory } from 'src/enums/news/news-category.enum';
import { GeneratedNews } from 'types/generated-news';

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
    const baseUrl = "https://npb.jp/news/npb_all.html";

    const collected = new Set<string>();
    let page = 1;

    while (collected.size < limit) {
      const url =
        page === 1 ? baseUrl : `${baseUrl}?page=${page}`;

      console.log(`Fetching NPB page: ${url}`);

      const { data: html } = await axios.get<string>(url, {
        timeout: 10_000,
      });

      const $ = cheerio.load(html);

      let foundOnThisPage = 0;

      $("a[href]").each((_, el) => {
        if (collected.size >= limit) return;

        const href = $(el).attr("href");
        if (!href) return;

        if (href.includes("/news/detail/")) {
          const abs = href.startsWith("http")
            ? href
            : `https://npb.jp${href}`;

          const normalized = abs.trim();
          if (!collected.has(normalized)) {
            collected.add(normalized);
            foundOnThisPage++;
          }
        }
      });

      // これ以上記事がない場合は終了
      if (foundOnThisPage === 0) break;

      page++;
    }

    return Array.from(collected).slice(0, limit);
  }

  /**
   * MLBニュース一覧HTMLから detail URL を自前で抽出する
   */
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

    // ★ 記事カード（ニュース）っぽい article を順に拾う
    // - ただし広告/別用途のarticleも混ざる可能性があるので軽くフィルタする
    $("article[id]").each((_, el) => {
      if (out.length >= limit) return;

      const id = ($(el).attr("id") || "").trim();
      if (!id) return;

      // ありがちなノイズ除外（必要なら追加）
      if (id.startsWith("ad-")) return;

      // slugっぽい形式だけ許可（英数/ハイフン）
      if (!/^[a-z0-9-]+$/i.test(id)) return;

      const url = `https://www.mlb.com/news/${id}`;

      if (seen.has(url)) return;
      seen.add(url);
      out.push(url);
    });

    return out;
  }

  /**
   * 日刊スポーツ（高校野球）一覧HTMLから詳細URLを自前で抽出
   * - li -> a の href を拾う
   * - DOM上から上から順に拾うので基本「最新順」
   */
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

      // 高校野球ニュースっぽいパスだけに絞る（必要なら調整）
      if (!abs.includes("/baseball/highschool/news/")) return;

      // クエリ除去
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

  /**
   * サンスポ（その他）一覧HTMLから詳細URLを自前で抽出
   * - li -> a の href を拾う
   * - DOM上から上から順に拾うので基本「最新順」
   */
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

    // サンスポの記事URLは /article/ を含むことが多い
    // 例: https://www.sanspo.com/article/20260218-XXXXXX/
    const isArticleUrl = (u: URL) => {
      // ドメインチェック
      if (!/(\.|^)sanspo\.com$/i.test(u.hostname)) return false;
      // 記事っぽいパスだけ残す（必要なら調整）
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
        // クエリ等は落とす
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

  /**
   * URL一覧を Gemini に渡して記事を生成（現状10件ずつ）
   * ※ここは Gemini 依存なので遅い。seedをSSRで待たないようにする。
   */
  async generateNewsFromUrls(
    urls: string[],
    category: NewsCategory,
    referenceName: string,
  ): Promise<GeneratedNews[]> {
    const batches = this.chunk(urls, 10);
    const results: GeneratedNews[] = [];

    for (const batch of batches) {
      const prompt = `
        あなたはプロの野球ニュース編集者です。
        以下のURLの記事をそれぞれ読み取り、事実に基づいて「要約」し、その要約を元に「再生成したニュース」を作ってください。

        # 厳守ルール
        - 推測・憶測・断定の追加は禁止（記事に書かれている事実のみ）
        - 誇張禁止、煽り禁止
        - 元記事の全文コピーは禁止（要約と再構成のみ）
        - 出力は必ずJSONのみ（コードフェンス不要、余計な文章禁止）

        # 文字数（全角目安）
        - header: 30〜38
        - subheader: 40前後
        - summary: 120〜180
        - body: 200〜600

        # 出力形式（必ずこの配列）
        [
          {
            "reference_url": "URL（必須）",
            "reference_name": "${referenceName}",
            "reference_published_at": "記事内の日時を優先して必ずISO形式で。（時間が不明な際は00:00:00で埋める。可能なら日本時間で。）",
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
    return await this.generateNewsFromUrls(urls, NewsCategory.NPB, 'NPB.jp | 日本野球機構');
  }

  /** まとめ：MLB 取得→生成 */
  async collectAndGenerateMlbNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestMlbUrls(limit);
    console.log("Fetched URLs:", urls);
    return await this.generateNewsFromUrls(urls, NewsCategory.MLB, 'MLB.com | The Official Site of Major League Baseball');
  }

  /** まとめ：HSB 取得→生成 */
  async collectAndGenerateHsbNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestHsbUrls(limit);
    console.log("Fetched URLs:", urls);
    return await this.generateNewsFromUrls(urls, NewsCategory.HSB, 'nikkansports.com | 日刊スポーツ');
  }

  /** まとめ：OTHER 取得→生成 */
  async collectAndGenerateOtherNews(limit = 10): Promise<GeneratedNews[]> {
    const urls = await this.fetchLatestOtherUrls(limit);
    console.log("Fetched URLs:", urls);
    return await this.generateNewsFromUrls(urls, NewsCategory.OTHER, 'sanspo.com | サンスポ');
  }
}
