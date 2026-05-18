import { NewsCategory } from '../../enums/news/news-category.enum';

export class NewsListItemDto {
  id: number;
  category: NewsCategory;
  header: string;
  summary: string;
  reference_url: string;
  reference_published_at: Date;
}
