import { NewsCategory } from '../../enums/news/news-category.enum';

export class NewsDetailDto {
  id: number;
  category: NewsCategory;
  header: string;
  subheader: string;
  body: string;
  summary: string;
  reference_name: string;
  reference_url: string;
  reference_published_at: Date;
  created_at: Date;
  updated_at: Date;
}
