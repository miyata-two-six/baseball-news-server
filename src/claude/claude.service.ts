import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as cheerio from 'cheerio';
import Anthropic from '@anthropic-ai/sdk';
import { NewsCategory } from '../enums/news/news-category.enum';
import { GeneratedNews } from '../../types/generated-news';

@Injectable()
export class ClaudeService {
  private readonly logger = new Logger(ClaudeService.name);

  private requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is not set`);
    return v;
  }

  private anthropic(): Anthropic {
    const apiKey = this.requireEnv('ANTHROPIC_API_KEY');
    return new Anthropic({ apiKey });
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  private parseJsonFromModel<T>(raw: string): T {
    // ClaudeをJSONモードで呼べば基本そのままJSONが返る想定。
    // それでも保険として、Geminiと同じ抽出を残してOK。
    const cleaned = raw.trim();

    // JSON配列だけを抽出（念のため）
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) throw new Error('JSON array not found');
    const json = cleaned.slice(start, end + 1);

    return JSON.parse(json) as T;
  }

  /**
   * URLから本文を取得して、Claudeへ渡す「検索/グラウンディングの代替」
   * - 取得できないURLは空文字で返す（モデルに「特定できないなら出力しない」ルールで落とす）
   */
  private async fetchArticleText(url: string): Promise<string> {
    try {
      const { data: html } = await axios.get<string>(url, {
        timeout: 15_000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        },
      });

      const $ = cheerio.load(html);

      // できるだけ本文を拾う（サイト毎に最適化するのが理想）
      const title = $('title').text().trim();
      const bodyText = $('main').text().trim() || $('article').text().trim() || $('body').text().trim();

      // 長すぎるとtokenを圧迫するので軽く制限（必要に応じて調整）
      const text = `${title}\n\n${bodyText}`.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      const result: string = text.slice(0, 12000);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Failed to fetch article: ${url} (${msg})`);
      return '';
    }
  }

  /**
   * Claudeで「URL一覧→生成」を実行
   * - Geminiの google_search tool の代わりに「本文抽出→投入」
   */
  private async claudeGenerateJson(prompt: string): Promise<string> {
    const client = this.anthropic();

    // Claudeは fetch/AbortController ではなくSDK呼び出しが基本
    // 429などはSDK側で例外になるので、外側でリトライする
    const model = process.env.CLAUDE_MODEL ?? 'claude-3-5-sonnet-latest';
    const maxTokens = 2048;

    try {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // SDKのレスポンスは content 配列（textブロック）で返る
      const textContent = res.content.filter((c) => c.type === 'text');
      const text = textContent
        .map((c) => {
          if (c.type === 'text') {
            return c.text;
          }
          return '';
        })
        .join('')
        .trim();

      if (!text) throw new Error('Claude returned empty text');
      return text;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Claude API error: ${msg}`);
    }
  }

  async generateNewsFromUrls(
    urls: string[],
    category: NewsCategory,
    referenceName: string,
  ): Promise<GeneratedNews[]> {
    const batches = this.chunk(urls, 1); // あなたと同じく1件ずつ
    const results: GeneratedNews[] = [];
    const seenUrls = new Set<string>();

    const normalizeUrl = (u: string) => {
      try {
        const x = new URL(u);
        x.search = '';
        x.hash = '';
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

    const buildPrompt = (targetUrl: string, extractedText: string) => `
Return ONLY a JSON array. NO extra text. NO markdown.
あなたはプロの野球ニュース編集者です。以下の「URL」と「抽出本文」を読み、記事の事実のみでニュースを再構成してください。

# 厳守ルール
- 推測・憶測の追加は禁止（本文に書かれている事実のみ）
- 元記事の全文コピーは禁止（要約と再構成のみ）
- どうしても本文から内容が特定できない場合は、その項目を配列に含めないでください
- 出力は必ず JSON配列のみ

# 文字数（全角目安）
- header: 30〜38
- subheader: 40前後
- summary: 120〜180
- body: 200〜500（文末は「。」）

# 出力形式（必ずこの配列）
[
  {
    "reference_url": "${targetUrl}",
    "reference_name": "${referenceName}",
    "reference_published_at": "記事内の日時を優先しISO形式。日付が不明なら本日（${new Date().toISOString()}）を使う。00など無効値は禁止。",
    "header": "…",
    "subheader": "…",
    "summary": "…",
    "body": "…",
    "category": "${category}"
  }
]

# URL
${targetUrl}

# 抽出本文
${extractedText ? extractedText : '(本文取得失敗：内容特定できない場合は配列に含めないこと)'}
`;

    const requestWithRetry = async (targetUrl: string, extractedText: string, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const raw = await this.claudeGenerateJson(buildPrompt(targetUrl, extractedText));
          const parsed = this.parseJsonFromModel<GeneratedNews[]>(raw);
          return parsed ?? [];
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (attempt >= maxRetries) {
            this.logger.warn(`Claude failed for ${targetUrl}: ${msg}`);
            return [];
          }
          const backoff = 2000 * (attempt + 1);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
      return [];
    };

    for (const batch of batches) {
      const u = batch[0];
      const normalized = normalizeUrl(u);
      if (seenUrls.has(normalized)) continue;

      // レート対策（Geminiと同じく間隔を空ける）
      if (results.length > 0) await new Promise((r) => setTimeout(r, 2000));

      // ★本文抽出（検索の代替）
      const extracted = await this.fetchArticleText(u);

      const parsed = await requestWithRetry(u, extracted, 2);

      for (const item of parsed) pushValidated(item);
    }

    return results;
  }

  // ====== 以下、あなたのURL抽出関数（NPB/MLB/HSB/OTHER）はそのまま移植OK ======
  // fetchLatestNpbUrls / fetchLatestMlbUrls / fetchLatestHsbUrls / fetchLatestOtherUrls
  // collectAndGenerateXxxNews も同様に generateNewsFromUrls を呼ぶだけ

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

  // ====== URL抽出（ここはあなたのコードをそのままコピペでOK） ======
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
}
