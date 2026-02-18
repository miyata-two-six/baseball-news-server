import { NewsCategory } from "src/enums/news/news-category.enum";

export interface GeneratedNews {
  reference_url: string;
  reference_name: string;
  reference_published_at: string;
  header: string;
  subheader: string;
  summary: string;
  body: string;
  category: NewsCategory;
}