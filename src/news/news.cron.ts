import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { NewsService } from "./news.service";
import { NewsCategory } from "src/enums/news/news-category.enum";

@Injectable()
export class NewsCron {
  private readonly logger = new Logger(NewsCron.name);

  constructor(private readonly newsService: NewsService) {}

  @Cron("0 */6 * * *")
  async seedNpb() {
    this.logger.log("Cron NPB");
    await this.newsService.syncLatest(NewsCategory.NPB);
  }

  @Cron("10 */6 * * *")
  async seedMlb() {
    this.logger.log("Cron MLB");
    await this.newsService.syncLatest(NewsCategory.MLB);
  }

  @Cron("20 */6 * * *")
  async seedHsb() {
    this.logger.log("Cron HSB");
    await this.newsService.syncLatest(NewsCategory.HSB);
  }

  @Cron("30 */6 * * *")
  async seedOther() {
    this.logger.log("Cron OTHER");
    await this.newsService.syncLatest(NewsCategory.OTHER);
  }

}
