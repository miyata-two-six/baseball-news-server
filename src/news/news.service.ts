import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GeminiService } from '../gemini/gemini.service';
import { News } from '../entities/news.entity';
import { NewsCategory } from '../enums/news/news-category.enum';
import { GeneratedNews } from 'types/generated-news';
import { NewsListItemDto } from './dto/news-list-item.dto';
import { NewsDetailDto } from './dto/news-detail.dto';
import { SeedStatus } from './types/seed-status.types';

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  // ★プロセス内メモリ（本番はRedis等にするのが理想）
  private seedStatus: Record<NewsCategory, SeedStatus> = {
    npb: { status: 'idle' },
    mlb: { status: 'idle' },
    hsb: { status: 'idle' },
    other: { status: 'idle' },
  };

  constructor(
    @InjectRepository(News) private readonly newsRepository: Repository<News>,
    private readonly geminiService: GeminiService,
  ) {}

  async getNewsByCategory(category: NewsCategory): Promise<NewsListItemDto[]> {
    return this.newsRepository
      .createQueryBuilder('news')
      .select([
        'news.id',
        'news.category',
        'news.header',
        'news.summary',
        'news.reference_url',
        'news.reference_published_at',
      ])
      .where('news.category = :category', { category })
      .orderBy('news.reference_published_at', 'DESC')
      .take(category === NewsCategory.NPB ? 30 : 10)
      .getMany() as Promise<NewsListItemDto[]>;
  }

  getSeedStatus(category: NewsCategory): SeedStatus {
    return this.seedStatus[category];
  }

  private async performSeed(category: NewsCategory, startedAt: Date): Promise<void> {
    let inserted = 0;
    let generated: GeneratedNews[] = [];

    if (category === NewsCategory.NPB) {
      generated = await this.geminiService.collectAndGenerateNpbNews();
    } else if (category === NewsCategory.MLB) {
      generated = await this.geminiService.collectAndGenerateMlbNews();
    } else if (category === NewsCategory.HSB) {
      generated = await this.geminiService.collectAndGenerateHsbNews();
    } else {
      generated = await this.geminiService.collectAndGenerateOtherNews();
    }
    console.log("Generated news from Gemini:", generated);
    console.log("Mapped category for DB:", category);

    const entities = generated.map((g) =>
      this.newsRepository.create({
        category: category,
        reference_url: g.reference_url,
        reference_name: g.reference_name,
        reference_published_at: g.reference_published_at || undefined,
        header: g.header,
        subheader: g.subheader,
        summary: g.summary,
        body: g.body,
      }),
    );
    console.log("Entities to save:", entities);

    await this.newsRepository.save(entities);
    inserted = entities.length;
    console.log(`Inserted ${inserted} news items into the database.`);

    this.seedStatus[category] = {
      status: 'done',
      startedAt,
      finishedAt: new Date(),
      inserted,
    };
  }

  /**
   * ★空ならseedを開始（ジョブ化）
   * - 既にrunningなら何もしない
   * - DBに既にあるならdone扱いにして何もしない
   */
  async startSeedIfEmpty(category: NewsCategory): Promise<SeedStatus> {
    const current = this.getSeedStatus(category);
    if (current.status === 'running') return current;

    const count = await this.newsRepository.count({ where: { category: category } });

    // 既にあるならseed不要
    if (count > 0) {
      this.seedStatus[category] = {
        status: 'done',
        startedAt: new Date(),
        finishedAt: new Date(),
        inserted: 0,
      };
      return this.seedStatus[category];
    }

    const startedAt = new Date();
    this.seedStatus[category] = { status: 'running', startedAt };

    // ★非同期ジョブ開始（APIは待たない）
    setImmediate(() => {
      this.performSeed(category, startedAt).catch((e) => {
        this.logger.error(e instanceof Error ? e.message : String(e));
        this.seedStatus[category] = {
          status: 'error',
          startedAt,
          error: e instanceof Error ? e.message : String(e),
        };
      });
    });

    return this.seedStatus[category];
  }

  async getNewsDetailByReferenceUrl(referenceUrl: string): Promise<NewsDetailDto> {
    const found = await this.newsRepository.findOne({
      where: { reference_url: referenceUrl },
    });

    if (!found) {
      throw new NotFoundException('news not found for reference_url');
    }
    return found as NewsDetailDto;
  }

  /**
   * ★カテゴリの最新ニュースを同期（差分のみ追加）
   */
  async syncLatest(category: NewsCategory) {
    let generated: GeneratedNews[] = [];

    if (category === NewsCategory.NPB) {
      generated = await this.geminiService.collectAndGenerateNpbNews(5);
    } else if (category === NewsCategory.MLB) {
      generated = await this.geminiService.collectAndGenerateMlbNews(5);
    } else if (category === NewsCategory.HSB) {
      generated = await this.geminiService.collectAndGenerateHsbNews(5);
    } else {
      generated = await this.geminiService.collectAndGenerateOtherNews(5);
    }

    // ★既存URL取得
    const existing = await this.newsRepository.find({
      where: { category },
      select: ["reference_url"],
    });

    const existingSet = new Set(existing.map(e => e.reference_url));

    // ★差分だけ
    const diff = generated.filter(g => !existingSet.has(g.reference_url));

    if (diff.length === 0) {
      this.logger.log("No new news");
      return 0;
    }

    const entities = diff.map(g =>
      this.newsRepository.create({
        category,
        reference_url: g.reference_url,
        reference_name: g.reference_name,
        reference_published_at: g.reference_published_at || undefined,
        header: g.header,
        subheader: g.subheader,
        summary: g.summary,
        body: g.body,
      })
    );

    await this.newsRepository.save(entities);

    this.logger.log(`Inserted ${entities.length} new news`);
    return entities.length;
  }
}
