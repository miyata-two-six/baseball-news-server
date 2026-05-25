import { Test, TestingModule } from '@nestjs/testing';
import { NewsCategory } from '../enums/news/news-category.enum';
import { NewsController } from './news.controller';
import { NewsService } from './news.service';

describe('NewsController', () => {
  let controller: NewsController;
  let newsService: jest.Mocked<Pick<NewsService, 'getNewsByCategory' | 'startSeedIfEmpty' | 'getSeedStatus' | 'getNewsDetailByReferenceUrl'>>;

  beforeEach(async () => {
    newsService = {
      getNewsByCategory: jest.fn(),
      startSeedIfEmpty: jest.fn(),
      getSeedStatus: jest.fn(),
      getNewsDetailByReferenceUrl: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NewsController],
      providers: [{ provide: NewsService, useValue: newsService }],
    }).compile();

    controller = module.get<NewsController>(NewsController);
  });

  it('should pass category to getNewsByCategory', async () => {
    const items = [{ id: 1 }];
    newsService.getNewsByCategory.mockResolvedValue(items as never);

    const result = await controller.getNewsByCategory(NewsCategory.MLB);

    expect(newsService.getNewsByCategory).toHaveBeenCalledWith(NewsCategory.MLB);
    expect(result).toBe(items);
  });

  it('should pass category to startSeedIfEmpty', async () => {
    const status = { status: 'running', startedAt: new Date() } as const;
    newsService.startSeedIfEmpty.mockResolvedValue(status as never);

    const result = await controller.startSeedIfEmpty(NewsCategory.HSB);

    expect(newsService.startSeedIfEmpty).toHaveBeenCalledWith(NewsCategory.HSB);
    expect(result).toBe(status);
  });

  it('should pass category to getSeedStatus', () => {
    const status = { status: 'idle' } as const;
    newsService.getSeedStatus.mockReturnValue(status as never);

    const result = controller.getSeedStatus(NewsCategory.NPB);

    expect(newsService.getSeedStatus).toHaveBeenCalledWith(NewsCategory.NPB);
    expect(result).toBe(status);
  });

  it('should pass url to getNewsDetailByReferenceUrl', async () => {
    const detail = { id: 1, reference_url: 'https://example.com' };
    newsService.getNewsDetailByReferenceUrl.mockResolvedValue(detail as never);

    const result = await controller.getNewsDetailByReferenceUrl('https://example.com');

    expect(newsService.getNewsDetailByReferenceUrl).toHaveBeenCalledWith('https://example.com');
    expect(result).toBe(detail);
  });
});
