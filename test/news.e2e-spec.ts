import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { NewsCategory } from 'src/enums/news/news-category.enum';
import { NewsService } from 'src/news/news.service';
import { AppModule } from '../src/app.module';

describe('NewsController (e2e)', () => {
  let app: INestApplication<App>;
  let newsServiceMock: {
    getNewsByCategory: jest.Mock;
    startSeedIfEmpty: jest.Mock;
    getSeedStatus: jest.Mock;
    getNewsDetailByReferenceUrl: jest.Mock;
  };

  beforeEach(async () => {
    newsServiceMock = {
      getNewsByCategory: jest.fn(),
      startSeedIfEmpty: jest.fn(),
      getSeedStatus: jest.fn(),
      getNewsDetailByReferenceUrl: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(NewsService)
      .useValue(newsServiceMock)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('baseball-news');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /news should pass category and return list', async () => {
    const items = [
      {
        id: 1,
        category: NewsCategory.NPB,
        header: 'NPB header',
        summary: 'NPB summary',
        reference_url: 'https://example.com/news-1',
        reference_published_at: '2026-05-05T00:00:00.000Z',
      },
    ];
    newsServiceMock.getNewsByCategory.mockResolvedValue(items);

    await request(app.getHttpServer())
      .get('/baseball-news/news')
      .query({ category: NewsCategory.NPB })
      .expect(200)
      .expect(items);

    expect(newsServiceMock.getNewsByCategory).toHaveBeenCalledWith(NewsCategory.NPB);
  });

  it('GET /news without category should default to NPB', async () => {
    const items = [
      {
        id: 2,
        category: NewsCategory.NPB,
        header: 'Default NPB header',
        summary: 'Default NPB summary',
        reference_url: 'https://example.com/news-2',
        reference_published_at: '2026-05-06T00:00:00.000Z',
      },
    ];
    newsServiceMock.getNewsByCategory.mockResolvedValue(items);

    await request(app.getHttpServer())
      .get('/baseball-news/news')
      .expect(200)
      .expect(items);

    expect(newsServiceMock.getNewsByCategory).toHaveBeenCalledWith(NewsCategory.NPB);
  });

  it('POST /news/seed should start seed and return status', async () => {
    const status = { status: 'running', startedAt: '2026-05-25T00:00:00.000Z' };
    newsServiceMock.startSeedIfEmpty.mockResolvedValue({
      status: 'running',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
    });

    await request(app.getHttpServer())
      .post('/baseball-news/news/seed')
      .query({ category: NewsCategory.MLB })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(status);
      });

    expect(newsServiceMock.startSeedIfEmpty).toHaveBeenCalledWith(NewsCategory.MLB);
  });

  it('POST /news/seed without category should default to NPB', async () => {
    const status = { status: 'running', startedAt: '2026-05-25T00:00:00.000Z' };
    newsServiceMock.startSeedIfEmpty.mockResolvedValue({
      status: 'running',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
    });

    await request(app.getHttpServer())
      .post('/baseball-news/news/seed')
      .expect(201)
      .expect(({ body }) => {
        expect(body).toEqual(status);
      });

    expect(newsServiceMock.startSeedIfEmpty).toHaveBeenCalledWith(NewsCategory.NPB);
  });

  it('GET /news/seed/status should return status', async () => {
    const status = {
      status: 'done',
      startedAt: '2026-05-25T00:00:00.000Z',
      finishedAt: '2026-05-25T00:01:00.000Z',
      inserted: 2,
    };
    newsServiceMock.getSeedStatus.mockReturnValue({
      status: 'done',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
      finishedAt: new Date('2026-05-25T00:01:00.000Z'),
      inserted: 2,
    });

    await request(app.getHttpServer())
      .get('/baseball-news/news/seed/status')
      .query({ category: NewsCategory.HSB })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual(status);
      });

    expect(newsServiceMock.getSeedStatus).toHaveBeenCalledWith(NewsCategory.HSB);
  });

  it('GET /news/by-reference-url should return detail', async () => {
    const detail = {
      id: 1,
      category: NewsCategory.NPB,
      header: 'Detail',
      subheader: 'Detail sub',
      body: 'Detail body',
      summary: 'Detail summary',
      reference_name: 'NPB source',
      reference_url: 'https://example.com/detail',
      reference_published_at: '2026-05-05T00:00:00.000Z',
    };
    newsServiceMock.getNewsDetailByReferenceUrl.mockResolvedValue(detail);

    await request(app.getHttpServer())
      .get('/baseball-news/news/by-reference-url')
      .query({ url: 'https://example.com/detail' })
      .expect(200)
      .expect(detail);

    expect(newsServiceMock.getNewsDetailByReferenceUrl).toHaveBeenCalledWith('https://example.com/detail');
  });

  it('GET /news/by-reference-url with non-existent URL should return 500', async () => {
    const error = new Error('NotFoundException: news not found for reference_url');
    newsServiceMock.getNewsDetailByReferenceUrl.mockRejectedValue(error);

    await request(app.getHttpServer())
      .get('/baseball-news/news/by-reference-url')
      .query({ url: 'https://non-existent.example/news' })
      .expect(500);

    expect(newsServiceMock.getNewsDetailByReferenceUrl).toHaveBeenCalledWith(
      'https://non-existent.example/news',
    );
  });

  it('GET /news/by-reference-url without url param should call service with undefined', async () => {
    newsServiceMock.getNewsDetailByReferenceUrl.mockRejectedValue(
      new Error('NotFoundException: news not found for reference_url'),
    );

    await request(app.getHttpServer())
      .get('/baseball-news/news/by-reference-url')
      .expect(500);

    expect(newsServiceMock.getNewsDetailByReferenceUrl).toHaveBeenCalledWith(undefined);
  });

  it('POST /news/seed with invalid category should coerce to default NPB', async () => {
    newsServiceMock.startSeedIfEmpty.mockResolvedValue({
      status: 'running',
      startedAt: new Date('2026-05-25T00:00:00.000Z'),
    });

    await request(app.getHttpServer())
      .post('/baseball-news/news/seed')
      .query({ category: 'INVALID_CATEGORY' })
      .expect(201);

    expect(newsServiceMock.startSeedIfEmpty).toHaveBeenCalled();
  });
});