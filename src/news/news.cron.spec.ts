import { Test, TestingModule } from '@nestjs/testing';
import { NewsCategory } from '../enums/news/news-category.enum';
import { NewsCron } from './news.cron';
import { NewsService } from './news.service';

describe('NewsCron', () => {
  let cron: NewsCron;
  let newsService: jest.Mocked<Pick<NewsService, 'syncLatest'>>;

  beforeEach(async () => {
    newsService = {
      syncLatest: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [NewsCron, { provide: NewsService, useValue: newsService }],
    }).compile();

    cron = module.get<NewsCron>(NewsCron);
  });

  it('should sync NPB news', async () => {
    newsService.syncLatest.mockResolvedValue(1 as never);

    await cron.seedNpb();

    expect(newsService.syncLatest).toHaveBeenCalledWith(NewsCategory.NPB);
  });

  it('should sync MLB news', async () => {
    newsService.syncLatest.mockResolvedValue(1 as never);

    await cron.seedMlb();

    expect(newsService.syncLatest).toHaveBeenCalledWith(NewsCategory.MLB);
  });

  it('should sync HSB news', async () => {
    newsService.syncLatest.mockResolvedValue(1 as never);

    await cron.seedHsb();

    expect(newsService.syncLatest).toHaveBeenCalledWith(NewsCategory.HSB);
  });

  it('should sync OTHER news', async () => {
    newsService.syncLatest.mockResolvedValue(1 as never);

    await cron.seedOther();

    expect(newsService.syncLatest).toHaveBeenCalledWith(NewsCategory.OTHER);
  });
});
