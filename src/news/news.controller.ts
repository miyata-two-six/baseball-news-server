import { Controller, Get, Post, Query } from '@nestjs/common';
import { NewsService } from './news.service';
import { NewsCategory } from 'src/enums/news/news-category.enum';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  async getNewsByCategory(@Query('category') category: NewsCategory = NewsCategory.NPB) {
    return this.newsService.getNewsByCategory(category);
  }

  // ★seed開始（即返し）
  @Post('seed')
  async startSeedIfEmpty(@Query('category') category: NewsCategory = NewsCategory.NPB) {
    const status = await this.newsService.startSeedIfEmpty(category);
    return status;
  }

  @Get('seed/status')
  getSeedStatus(@Query('category') category: NewsCategory = NewsCategory.NPB) {
    return this.newsService.getSeedStatus(category);
  }

  @Get('by-reference-url')
  getNewsDetailByReferenceUrl(@Query('url') url: string) {
    return this.newsService.getNewsDetailByReferenceUrl(url);
  }
}
