import { Controller, Get, Post, Query } from '@nestjs/common';
import { NewsService } from './news.service';

type CategoryQuery = 'npb' | 'mlb' | 'hs' | 'other';

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  async getNews(@Query('category') category: CategoryQuery = 'npb') {
    return this.newsService.findByCategory(category);
  }

  // ★seed開始（即返し）
  @Post('seed')
  async seed(@Query('category') category: CategoryQuery = 'npb') {
    const status = await this.newsService.startSeedIfEmpty(category);
    // 202的な意味でstatusを返す（HTTPコードまで厳密にしたければ @Res で調整）
    return status;
  }

  @Get('seed/status')
  seedStatus(@Query('category') category: CategoryQuery = 'npb') {
    return this.newsService.getSeedStatus(category);
  }

  // ★追加：reference_url で1件取得
  @Get('by-reference-url')
  getByReferenceUrl(@Query('url') url: string) {
    return this.newsService.findByReferenceUrl(url);
  }
}
