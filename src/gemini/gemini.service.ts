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

  // 1. モデル名を実在する最新のものに変更
  // Groundingを使う場合は v1beta を使用するのが確実です
  private readonly endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  private async geminiGenerateText(prompt: string): Promise<string> {
    const apiKey = this.requireEnv('GEMINI_API_KEY');
    const timeoutMs = 600_000;
    const maxRetry = 3;

    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(`${this.endpoint}?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 2048,
            },
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (res.status === 429 && attempt < maxRetry) {
            const backoff = 15000 * (attempt + 1);
            this.logger.warn(`Gemini 429 (Rate Limit). Retrying in ${backoff}ms...`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          throw new Error(`Gemini API error: ${res.status} ${text}`);
        }

        const data = (await res.json()) as GeminiResponse;
        const out =
          data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

        if (!out.trim()) throw new Error('Gemini returned empty text');
        this.logger.debug(`Gemini RAW OUTPUT:\n${out}`);
        return out;
      } catch (e) {
        if (attempt >= maxRetry) throw e;
        const backoff = 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, backoff));
      } finally {
        clearTimeout(t);
      }
    }

    throw new Error('Gemini failed after retries');
  }

  private parseJsonFromModel<T>(raw: string): T {
    try {
      // code fence削除
      const cleaned = raw
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      // ★最初の [ と最後の ] だけ使う
      const start = cleaned.indexOf("[");
      const end = cleaned.lastIndexOf("]");

      if (start === -1 || end === -1) {
        throw new Error("JSON array not found");
      }

      let json = cleaned.slice(start, end + 1);

      // ★文字列内改行をエスケープ
      json = json.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/gs, (match) => {
        return match.replace(/\n/g, "\\n");
      });

      this.logger.debug("Gemini JSON EXTRACTED:\n" + json);

      return JSON.parse(json) as T;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error("JSON Parse Error FINAL: " + msg);
      throw e;
    }
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
    const batches = this.chunk(urls, 2);
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
        header: (item.header ?? "").slice(0, 490),
        summary: (item.summary ?? "").slice(0, 490),
      });
      return true;
    };

    const buildPrompt = (targetUrls: string[]) => `
  Return ONLY a JSON array. NO introductory text. NO markdown code blocks.
  あなたはプロの野球ニュース編集者です。
  Google Searchツールを使用して、以下の各URLの記事内容を確認してください。

  # 重要
  - もしURLに直接アクセスできない場合は、URL内の日付やキーワードを元に検索を行い、該当するニュースを特定してください。
  - 事実（スコア、選手名、記録、公式発表内容）のみを抽出してください。
  - どうしても内容が特定できないURLについては、その項目を配列に含めないでください。

  # 厳守ルール
  - 推測・憶測・断定の追加は禁止（記事に書かれている事実のみ）
  - 元記事の全文コピーは禁止（要約と再構成のみ）
  - 文字数を厳守してください（全角目安）
  - 必ずJSON配列だけ返してください。説明は不要。

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
      "subheader": "… or \\"\\"",
      "summary": "…",
      "body": "…（文末は「。」を使う）",
      "category": "${category}"
    }
  ]

  # 対象URL（新しい順のまま処理）
  ${targetUrls.map((u) => `- ${u}`).join("\n")}
  `;

    // ★ 空レス時の再試行（バッチ→1件ずつ）
    const requestOnce = async (targetUrls: string[]) => {
      try {
        const text = await this.geminiGenerateText(buildPrompt(targetUrls));

        // 「```」しか返ってこない等の空レスを明示的に扱う
        if (!text || !text.trim() || text.trim() === "```") return [];

        const parsed = this.parseJsonFromModel<GeneratedNews[]>(text);
        return parsed ?? [];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`requestOnce failed (treat as empty): ${msg}`);
        return [];
      }
    };


    for (const batch of batches) {
      if (results.length > 0) await new Promise((r) => setTimeout(r, 10_000));

      try {
        const parsed = await requestOnce(batch);

        let added = 0;
        for (const item of parsed) {
          if (pushValidated(item)) added++;
        }

        // ✅ 空レス（or 追加0件）のときだけ、そのバッチURLを“もう一度だけ”リトライ
        if (parsed.length === 0 || added === 0) {
          this.logger.warn(`Empty/zero-added response. Retrying per-URL for batch: ${batch.join(", ")}`);

          // 1件ずつ（確実性上げる）
          for (const u of batch) {
            // すでに取れてるならスキップ
            if (seenUrls.has(normalizeUrl(u))) continue;

            await new Promise((r) => setTimeout(r, 4000)); // ちょい待つ（429/負荷対策）

            try {
              const parsedOne = await requestOnce([u]);
              for (const item of parsedOne) {
                pushValidated(item);
              }
            } catch (e) {
              const errorMsg = e instanceof Error ? e.message : String(e);
              this.logger.warn(`Retry(per-URL) failed for ${u}: ${errorMsg}`);
            }
          }
        }
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        this.logger.error(`Failed to process batch: ${errorMsg}`);
        continue;
      }
    }

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