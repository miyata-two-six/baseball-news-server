import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GeminiService } from '../gemini/gemini.service';
import { News } from '../entities/news.entity';
import { NewsCategory } from '../enums/news/news-category.enum';

type CategoryQuery = 'npb' | 'mlb' | 'hs' | 'other';

type SeedStatus =
  | { status: 'idle' }
  | { status: 'running'; startedAt: string }
  | { status: 'done'; startedAt: string; finishedAt: string; inserted: number }
  | { status: 'error'; startedAt: string; error: string };

@Injectable()
export class NewsService {
  private readonly logger = new Logger(NewsService.name);

  // ★プロセス内メモリ（本番はRedis等にするのが理想）
  private seedStatus: Record<CategoryQuery, SeedStatus> = {
    npb: { status: 'idle' },
    mlb: { status: 'idle' },
    hs: { status: 'idle' },
    other: { status: 'idle' },
  };

  constructor(
    @InjectRepository(News) private readonly newsRepository: Repository<News>,
    private readonly geminiService: GeminiService,
  ) {}

  private mapCategory(category: CategoryQuery): NewsCategory {
    switch (category) {
      case 'npb':
        return NewsCategory.NPB;
      case 'mlb':
        return NewsCategory.MLB;
      case 'hs':
        return NewsCategory.HS;
      default:
        return NewsCategory.OTHER;
    }
  }

  async findByCategory(category: CategoryQuery): Promise<News[]> {
    const dbCategory = this.mapCategory(category);
    return this.newsRepository.find({
      where: { category: dbCategory },
      order: { reference_published_at: 'DESC' },
      take: 100,
    });
  }

  getSeedStatus(category: CategoryQuery): SeedStatus {
    return this.seedStatus[category] ?? { status: 'idle' };
  }

  private async performSeed(category: CategoryQuery, startedAt: string): Promise<void> {
    let inserted = 0;

    if (category === 'npb') {
      const generated = await this.geminiService.collectAndGenerateNpbNews(10); // まずは10件推奨
      console.log("Generated news from Gemini:", generated);

      const dbCategory = this.mapCategory(category);
      console.log("Mapped category for DB:", dbCategory);

      const entities = generated.map((g) =>
        this.newsRepository.create({
          category: dbCategory,
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
    } else {
      // TODO: MLB/HS/OTHER
      inserted = 0;
    }

    this.seedStatus[category] = {
      status: 'done',
      startedAt,
      finishedAt: new Date().toISOString(),
      inserted,
    };
  }

  /**
   * ★空ならseedを開始（ジョブ化）
   * - 既にrunningなら何もしない
   * - DBに既にあるならdone扱いにして何もしない
   */
  async startSeedIfEmpty(category: CategoryQuery): Promise<SeedStatus> {
    const current = this.getSeedStatus(category);
    if (current.status === 'running') return current;

    const dbCategory = this.mapCategory(category);
    const count = await this.newsRepository.count({ where: { category: dbCategory } });

    // 既にあるならseed不要
    if (count > 0) {
      this.seedStatus[category] = {
        status: 'done',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        inserted: 0,
      };
      return this.seedStatus[category];
    }

    const startedAt = new Date().toISOString();
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

  async findByReferenceUrl(referenceUrl: string): Promise<News> {
  const found = await this.newsRepository.findOne({
    where: { reference_url: referenceUrl },
  });

  if (!found) {
    throw new NotFoundException('news not found for reference_url');
  }
  return found;
}
}
