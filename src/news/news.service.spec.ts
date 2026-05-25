import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { News } from '../entities/news.entity';
import { NewsCategory } from '../enums/news/news-category.enum';
import { GeminiService } from '../gemini/gemini.service';
import { NewsService } from './news.service';

describe('NewsService', () => {
  let service: NewsService;
  let newsRepository: jest.Mocked<Partial<Repository<News>>>;
  let geminiService: jest.Mocked<Partial<GeminiService>>;

  const createQueryBuilderMock = () => {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };

    return qb;
  };

  beforeEach(async () => {
    newsRepository = {
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    geminiService = {
      collectAndGenerateNpbNews: jest.fn(),
      collectAndGenerateMlbNews: jest.fn(),
      collectAndGenerateHsbNews: jest.fn(),
      collectAndGenerateOtherNews: jest.fn(),
    } as Partial<GeminiService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsService,
        {
          provide: getRepositoryToken(News),
          useValue: newsRepository,
        },
        {
          provide: GeminiService,
          useValue: geminiService,
        },
      ],
    }).compile();

    service = module.get<NewsService>(NewsService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getNewsByCategory', () => {
    it('should return NPB news with 30 item limit', async () => {
      const qb = createQueryBuilderMock();
      const items = [{ id: 1, category: NewsCategory.NPB } as News];
      qb.getMany.mockResolvedValue(items);
      (newsRepository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      const result = await service.getNewsByCategory(NewsCategory.NPB);

      expect(newsRepository.createQueryBuilder).toHaveBeenCalledWith('news');
      expect(qb.select).toHaveBeenCalled();
      expect(qb.where).toHaveBeenCalledWith('news.category = :category', {
        category: NewsCategory.NPB,
      });
      expect(qb.orderBy).toHaveBeenCalledWith('news.reference_published_at', 'DESC');
      expect(qb.take).toHaveBeenCalledWith(30);
      expect(result).toBe(items);
    });

    it('should return non-NPB news with 10 item limit', async () => {
      const qb = createQueryBuilderMock();
      qb.getMany.mockResolvedValue([]);
      (newsRepository.createQueryBuilder as jest.Mock).mockReturnValue(qb);

      await service.getNewsByCategory(NewsCategory.MLB);

      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  describe('getNewsDetailByReferenceUrl', () => {
    it('should return a news detail when found', async () => {
      const found = {
        id: 1,
        reference_url: 'https://example.com/news/1',
      } as News;
      (newsRepository.findOne as jest.Mock).mockResolvedValue(found);

      const result = await service.getNewsDetailByReferenceUrl(found.reference_url);

      expect(newsRepository.findOne).toHaveBeenCalledWith({
        where: { reference_url: found.reference_url },
      });
      expect(result).toBe(found);
    });

    it('should throw NotFoundException when not found', async () => {
      (newsRepository.findOne as jest.Mock).mockResolvedValue(null);

      await expect(
        service.getNewsDetailByReferenceUrl('https://example.com/missing'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('startSeedIfEmpty', () => {
    it('should return done when news already exists', async () => {
      (newsRepository.count as jest.Mock).mockResolvedValue(1);

      const result = await service.startSeedIfEmpty(NewsCategory.NPB);

      expect(newsRepository.count).toHaveBeenCalledWith({
        where: { category: NewsCategory.NPB },
      });
      expect(result.status).toBe('done');
    });

    it('should return running when empty', async () => {
      const immediateSpy = jest
        .spyOn(globalThis, 'setImmediate')
        .mockImplementation((() => 0 as never) as unknown as typeof setImmediate);

      (newsRepository.count as jest.Mock).mockResolvedValue(0);

      const result = await service.startSeedIfEmpty(NewsCategory.NPB);

      expect(result.status).toBe('running');
      expect(newsRepository.count).toHaveBeenCalledWith({
        where: { category: NewsCategory.NPB },
      });
      expect(immediateSpy).toHaveBeenCalled();
    });

    it('should update status to error when seed fails', async () => {
      const immediateSpy = jest
        .spyOn(globalThis, 'setImmediate')
        .mockImplementation(((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
          callback(...args);
          return 0 as never;
        }) as unknown as typeof setImmediate);

      (newsRepository.count as jest.Mock).mockResolvedValue(0);
      (geminiService.collectAndGenerateNpbNews as jest.Mock).mockRejectedValue(
        new Error('gemini failed'),
      );

      await service.startSeedIfEmpty(NewsCategory.NPB);

      for (let i = 0; i < 10; i++) {
        if (service.getSeedStatus(NewsCategory.NPB).status === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(immediateSpy).toHaveBeenCalled();
      expect(service.getSeedStatus(NewsCategory.NPB).status).toBe('error');
    });
  });

  describe('syncLatest', () => {
    it('should save only new items', async () => {
      (geminiService.collectAndGenerateNpbNews as jest.Mock).mockResolvedValue([
        {
          reference_url: 'https://example.com/existing',
          reference_name: 'Existing',
          reference_published_at: '2026-05-25T00:00:00.000Z',
          header: 'Existing Header',
          subheader: 'Existing Subheader',
          summary: 'Existing Summary',
          body: 'Existing Body',
          category: NewsCategory.NPB,
        },
        {
          reference_url: 'https://example.com/new',
          reference_name: 'New',
          reference_published_at: '2026-05-25T00:00:00.000Z',
          header: 'New Header',
          subheader: 'New Subheader',
          summary: 'New Summary',
          body: 'New Body',
          category: NewsCategory.NPB,
        },
      ]);
      (newsRepository.find as jest.Mock).mockResolvedValue([
        { reference_url: 'https://example.com/existing' },
      ]);
      (newsRepository.create as jest.Mock).mockImplementation((input) => input as News);
      (newsRepository.save as jest.Mock).mockResolvedValue([]);

      const result = await service.syncLatest(NewsCategory.NPB);

      expect(result).toBe(1);
      expect(newsRepository.save).toHaveBeenCalledTimes(1);
      const savedEntities = (newsRepository.save as jest.Mock).mock
        .calls[0] as [News[]];
      expect(savedEntities[0]).toHaveLength(1);
    });

    it('should return 0 when there is no new news', async () => {
      (geminiService.collectAndGenerateNpbNews as jest.Mock).mockResolvedValue([
        {
          reference_url: 'https://example.com/existing',
          reference_name: 'Existing',
          reference_published_at: '2026-05-25T00:00:00.000Z',
          header: 'Existing Header',
          subheader: 'Existing Subheader',
          summary: 'Existing Summary',
          body: 'Existing Body',
          category: NewsCategory.NPB,
        },
      ]);
      (newsRepository.find as jest.Mock).mockResolvedValue([
        { reference_url: 'https://example.com/existing' },
      ]);
      (newsRepository.create as jest.Mock).mockImplementation((input) => input as News);

      const result = await service.syncLatest(NewsCategory.NPB);

      expect(result).toBe(0);
      expect(newsRepository.save).not.toHaveBeenCalled();
    });
  });
});
