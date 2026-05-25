import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { DataSource } from 'typeorm';
import { News } from '../src/entities/news.entity';
import { NewsCategory } from '../src/enums/news/news-category.enum';

interface NewsDetailResponse {
  id: number;
  category: NewsCategory;
  header: string;
  subheader: string;
  body: string;
  summary: string;
  reference_name: string;
  reference_url: string;
  reference_published_at: string;
  created_at?: string;
  updated_at?: string;
}

describe('NewsController (e2e with DB)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let moduleFixture: TestingModule;

  const createSchema = async () => {
    await dataSource.query('DROP TABLE IF EXISTS "news";');
    await dataSource.query('DROP TYPE IF EXISTS "news_category_enum";');
    await dataSource.query(`
      CREATE TYPE "news_category_enum" AS ENUM ('npb', 'mlb', 'hsb', 'other');
    `);
    await dataSource.query(`
      CREATE TABLE "news" (
        "id" SERIAL NOT NULL,
        "category" "news_category_enum" NOT NULL DEFAULT 'npb',
        "header" character varying(100) NOT NULL,
        "subheader" character varying(100) NOT NULL,
        "body" character varying(1000) NOT NULL,
        "summary" character varying(300) NOT NULL,
        "reference_name" character varying(200) NOT NULL,
        "reference_url" character varying(600) NOT NULL,
        "reference_published_at" TIMESTAMPTZ NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_news_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_news_reference_url" UNIQUE ("reference_url")
      );
    `);
    await dataSource.query(`CREATE INDEX "IDX_news_category" ON "news" ("category");`);
    await dataSource.query(`CREATE INDEX "IDX_news_created_at" ON "news" ("created_at");`);
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('baseball-news');
    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
    await createSchema();
  });

  afterAll(async () => {
    try {
      await dataSource.getRepository(News).clear();
    } catch {}
    await app.close();
    await moduleFixture.close();
    try {
      // attempt to destroy datasource if available
      if (dataSource) await dataSource.destroy();
    } catch {}
  });

  it('saves a news item to DB and retrieves it by reference URL', async () => {
    const repo = dataSource.getRepository(News);
    const saved = await repo.save({
      category: NewsCategory.NPB,
      header: 'E2E DB header',
      subheader: 'E2E sub',
      body: 'E2E body',
      summary: 'E2E summary',
      reference_name: 'e2e source',
      reference_url: 'https://e2e.example/news-db-1',
      reference_published_at: new Date('2026-05-01T00:00:00.000Z'),
    } as Partial<News>);

    const res = (await request(app.getHttpServer())
      .get('/baseball-news/news/by-reference-url')
      .query({ url: 'https://e2e.example/news-db-1' })
      .expect(200)) as { body: NewsDetailResponse };

    const body: NewsDetailResponse = res.body;

    expect(body).toBeDefined();
    expect(body.reference_url).toBe('https://e2e.example/news-db-1');
    expect(body.header).toBe('E2E DB header');
    expect(new Date(body.reference_published_at).toISOString()).toBe(
      saved.reference_published_at.toISOString(),
    );
  });
});
