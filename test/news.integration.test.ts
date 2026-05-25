import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { News } from 'src/entities/news.entity';
import { NewsCategory } from 'src/enums/news/news-category.enum';
import { GeminiService } from 'src/gemini/gemini.service';
import { NewsService } from 'src/news/news.service';

describe('NewsService integration', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: NewsService;
  let newsRepository: Repository<News>;

  const geminiServiceMock = {
    collectAndGenerateNpbNews: jest.fn(),
    collectAndGenerateMlbNews: jest.fn(),
    collectAndGenerateHsbNews: jest.fn(),
    collectAndGenerateOtherNews: jest.fn(),
  };

  const dbOptions = {
    type: 'postgres' as const,
    host: process.env.TEST_DB_HOST ?? process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.TEST_DB_PORT ?? process.env.DB_PORT ?? 5432),
    username: process.env.TEST_DB_USERNAME ?? process.env.DB_USERNAME ?? 'postgres',
    password: process.env.TEST_DB_PASSWORD ?? process.env.DB_PASSWORD ?? 'password',
    database: process.env.TEST_DB_DATABASE ?? process.env.DB_DATABASE ?? 'baseball_news',
    entities: [News],
    synchronize: true,
    dropSchema: true,
    logging: false,
    retryAttempts: 10,
    retryDelay: 1000,
  };

  beforeAll(async () => {
    jest.setTimeout(60000);

    moduleRef = await Test.createTestingModule({
      imports: [TypeOrmModule.forRoot(dbOptions), TypeOrmModule.forFeature([News])],
      providers: [
        NewsService,
        {
          provide: GeminiService,
          useValue: geminiServiceMock,
        },
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(NewsService);
    newsRepository = moduleRef.get<Repository<News>>(getRepositoryToken(News));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await newsRepository.clear();
  });

  const waitForSeedStatus = async (
    category: NewsCategory,
    expectedStatus: 'running' | 'done' | 'error',
    timeoutMs = 15000,
  ) => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const status = service.getSeedStatus(category);
      if (status.status === expectedStatus) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timed out waiting for seed status: ${expectedStatus}`);
  };

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('returns only the requested category in descending order', async () => {
    await newsRepository.save([
      {
        category: NewsCategory.NPB,
        header: 'Old NPB',
        subheader: 'Old NPB sub',
        body: 'Old body',
        summary: 'Old summary',
        reference_name: 'NPB source',
        reference_url: 'https://example.com/npb-old',
        reference_published_at: new Date('2026-05-01T00:00:00.000Z'),
      },
      {
        category: NewsCategory.NPB,
        header: 'New NPB',
        subheader: 'New NPB sub',
        body: 'New body',
        summary: 'New summary',
        reference_name: 'NPB source',
        reference_url: 'https://example.com/npb-new',
        reference_published_at: new Date('2026-05-02T00:00:00.000Z'),
      },
      {
        category: NewsCategory.MLB,
        header: 'MLB',
        subheader: 'MLB sub',
        body: 'MLB body',
        summary: 'MLB summary',
        reference_name: 'MLB source',
        reference_url: 'https://example.com/mlb',
        reference_published_at: new Date('2026-05-03T00:00:00.000Z'),
      },
    ] as News[]);

    const result = await service.getNewsByCategory(NewsCategory.NPB);

    expect(result).toHaveLength(2);
    expect(result[0].reference_url).toBe('https://example.com/npb-new');
    expect(result[1].reference_url).toBe('https://example.com/npb-old');
    expect(result.every((item) => item.category === NewsCategory.NPB)).toBe(true);
  });

  it('syncLatest saves only new news into the database', async () => {
    await newsRepository.save({
      category: NewsCategory.NPB,
      header: 'Existing',
      subheader: 'Existing sub',
      body: 'Existing body',
      summary: 'Existing summary',
      reference_name: 'NPB source',
      reference_url: 'https://example.com/existing',
      reference_published_at: new Date('2026-05-01T00:00:00.000Z'),
    } as News);

    geminiServiceMock.collectAndGenerateNpbNews.mockResolvedValue([
      {
        reference_url: 'https://example.com/existing',
        reference_name: 'Existing',
        reference_published_at: '2026-05-01T00:00:00.000Z',
        header: 'Existing',
        subheader: 'Existing sub',
        summary: 'Existing summary',
        body: 'Existing body',
        category: NewsCategory.NPB,
      },
      {
        reference_url: 'https://example.com/new',
        reference_name: 'New',
        reference_published_at: '2026-05-02T00:00:00.000Z',
        header: 'New',
        subheader: 'New sub',
        summary: 'New summary',
        body: 'New body',
        category: NewsCategory.NPB,
      },
    ]);

    const result = await service.syncLatest(NewsCategory.NPB);

    expect(result).toBe(1);

    const saved = await newsRepository.find({
      where: { category: NewsCategory.NPB },
      order: { reference_published_at: 'ASC' },
    });

    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.reference_url)).toEqual([
      'https://example.com/existing',
      'https://example.com/new',
    ]);
  });

  it('getNewsDetailByReferenceUrl returns the stored record', async () => {
    const publishedAt = new Date('2026-05-04T00:00:00.000Z');

    await newsRepository.save({
      category: NewsCategory.NPB,
      header: 'Detail',
      subheader: 'Detail sub',
      body: 'Detail body',
      summary: 'Detail summary',
      reference_name: 'NPB source',
      reference_url: 'https://example.com/detail',
      reference_published_at: publishedAt,
    } as News);

    const result = await service.getNewsDetailByReferenceUrl('https://example.com/detail');

    expect(result).toMatchObject({
      category: NewsCategory.NPB,
      header: 'Detail',
      subheader: 'Detail sub',
      body: 'Detail body',
      summary: 'Detail summary',
      reference_name: 'NPB source',
      reference_url: 'https://example.com/detail',
      reference_published_at: publishedAt,
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeInstanceOf(Date);
    expect(result.updated_at).toBeInstanceOf(Date);
  });

  it('startSeedIfEmpty returns running first and then saves new news', async () => {
    geminiServiceMock.collectAndGenerateNpbNews.mockResolvedValue([
      {
        reference_url: 'https://example.com/seed-new',
        reference_name: 'Seed source',
        reference_published_at: '2026-05-05T00:00:00.000Z',
        header: 'Seed header',
        subheader: 'Seed subheader',
        summary: 'Seed summary',
        body: 'Seed body',
        category: NewsCategory.NPB,
      },
    ]);

    const initialStatus = await service.startSeedIfEmpty(NewsCategory.NPB);

    expect(initialStatus.status).toBe('running');

    const doneStatus = await waitForSeedStatus(NewsCategory.NPB, 'done');

    expect(doneStatus.status).toBe('done');
    if (doneStatus.status !== 'done') {
      throw new Error('Expected done status');
    }
    expect(doneStatus.inserted).toBe(1);

    const saved = await newsRepository.find({
      where: { category: NewsCategory.NPB },
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      category: NewsCategory.NPB,
      header: 'Seed header',
      subheader: 'Seed subheader',
      summary: 'Seed summary',
      body: 'Seed body',
      reference_name: 'Seed source',
      reference_url: 'https://example.com/seed-new',
    });
  });

  it('startSeedIfEmpty returns done when data already exists', async () => {
    await newsRepository.save({
      category: NewsCategory.NPB,
      header: 'Existing',
      subheader: 'Existing sub',
      body: 'Existing body',
      summary: 'Existing summary',
      reference_name: 'NPB source',
      reference_url: 'https://example.com/existing',
      reference_published_at: new Date('2026-05-01T00:00:00.000Z'),
    } as News);

    const status = await service.startSeedIfEmpty(NewsCategory.NPB);

    expect(status.status).toBe('done');
    if (status.status !== 'done') {
      throw new Error('Expected done status');
    }
    expect(status.inserted).toBe(0);

    expect(geminiServiceMock.collectAndGenerateNpbNews).not.toHaveBeenCalled();

    const saved = await newsRepository.find({
      where: { category: NewsCategory.NPB },
    });

    expect(saved).toHaveLength(1);
    expect(saved[0].reference_url).toBe('https://example.com/existing');
  });
});