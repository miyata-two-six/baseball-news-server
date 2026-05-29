import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { load } from 'js-yaml';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppController } from '../src/app.controller';
import { AppService } from '../src/app.service';
import { NewsCategory } from '../src/enums/news/news-category.enum';
import { NewsController } from '../src/news/news.controller';
import { NewsService } from '../src/news/news.service';

type OpenApiSpec = {
  servers?: Array<{ url?: string }>;
  paths?: Record<string, Record<string, { operationId?: string }>>;
};

describe('OpenAPI contract', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;

  const newsServiceMock = {
    getNewsByCategory: jest.fn(),
    startSeedIfEmpty: jest.fn(),
    getSeedStatus: jest.fn(),
    getNewsDetailByReferenceUrl: jest.fn(),
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      controllers: [AppController, NewsController],
      providers: [
        AppService,
        {
          provide: NewsService,
          useValue: newsServiceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('baseball-news');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    await moduleFixture.close();
  });

  it('matches the documented base URL and route definitions', () => {
    const specPath = join(__dirname, '../openapi.yaml');
    const spec = load(readFileSync(specPath, 'utf8')) as OpenApiSpec;

    expect(spec.servers?.[0]?.url).toBe('http://localhost:3000/baseball-news');

    expect(spec.paths).toMatchObject({
      '/': {
        get: { operationId: 'getHello' },
      },
      '/news': {
        get: { operationId: 'getNewsByCategory' },
      },
      '/news/seed': {
        post: { operationId: 'startSeedIfEmpty' },
      },
      '/news/seed/status': {
        get: { operationId: 'getSeedStatus' },
      },
      '/news/by-reference-url': {
        get: { operationId: 'getNewsDetailByReferenceUrl' },
      },
    });
  });

  it('exposes the documented endpoints at runtime', async () => {
    newsServiceMock.getNewsByCategory.mockResolvedValue([
      {
        id: 1,
        category: NewsCategory.NPB,
        header: 'Headline',
        summary: 'Summary',
        reference_url: 'https://example.com/news/1',
        reference_published_at: '2026-05-25T00:00:00.000Z',
      },
    ]);
    newsServiceMock.startSeedIfEmpty.mockResolvedValue({
      status: 'running',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
    });
    newsServiceMock.getSeedStatus.mockReturnValue({
      status: 'done',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
      finishedAt: new Date('2026-05-25T00:01:00.000Z'),
      inserted: 1,
    });
    newsServiceMock.getNewsDetailByReferenceUrl.mockResolvedValue({
      id: 1,
      category: NewsCategory.NPB,
      header: 'Detail',
      subheader: 'Subheader',
      body: 'Body',
      summary: 'Summary',
      reference_name: 'Source',
      reference_url: 'https://example.com/news/1',
      reference_published_at: '2026-05-25T00:00:00.000Z',
      created_at: '2026-05-25T00:00:00.000Z',
      updated_at: '2026-05-25T00:00:00.000Z',
    });

    await request(app.getHttpServer())
      .get('/baseball-news/')
      .expect(200)
      .expect('Hello World!');

    await request(app.getHttpServer())
      .get('/baseball-news/news')
      .query({ category: NewsCategory.NPB })
      .expect(200)
      .expect(({ body }: { body: unknown }) => {
        expect(Array.isArray(body)).toBe(true);
        if (!Array.isArray(body)) {
          throw new Error('Expected news list to be an array');
        }
        expect(body[0]).toMatchObject({
          id: 1,
          category: NewsCategory.NPB,
          header: 'Headline',
          summary: 'Summary',
          reference_url: 'https://example.com/news/1',
          reference_published_at: '2026-05-25T00:00:00.000Z',
        });
      });

    await request(app.getHttpServer())
      .post('/baseball-news/news/seed')
      .query({ category: NewsCategory.NPB })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'running',
          startedAt: '2026-05-25T00:00:00.000Z',
        });
      });

    await request(app.getHttpServer())
      .get('/baseball-news/news/seed/status')
      .query({ category: NewsCategory.NPB })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'done',
          startedAt: '2026-05-25T00:00:00.000Z',
          finishedAt: '2026-05-25T00:01:00.000Z',
          inserted: 1,
        });
      });

    await request(app.getHttpServer())
      .get('/baseball-news/news/by-reference-url')
      .query({ url: 'https://example.com/news/1' })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: 1,
          category: NewsCategory.NPB,
          header: 'Detail',
          subheader: 'Subheader',
          body: 'Body',
          summary: 'Summary',
          reference_name: 'Source',
          reference_url: 'https://example.com/news/1',
          reference_published_at: '2026-05-25T00:00:00.000Z',
          created_at: '2026-05-25T00:00:00.000Z',
          updated_at: '2026-05-25T00:00:00.000Z',
        });
      });
  });
});