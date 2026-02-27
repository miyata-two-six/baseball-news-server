import {
  IsEnum,
  IsNotEmpty,
  IsString,
  Length,
  IsDateString,
  IsUrl,
} from 'class-validator';
import { NewsCategory } from 'src/enums/news/news-category.enum';

export class RegisterDto {
  @IsNotEmpty({ message: 'カテゴリを設定してください' })
  @IsEnum(NewsCategory, {
    message:
      'カテゴリは NPB / MLB / 高校野球 / その他 のいずれかである必要があります',
  })
  category: NewsCategory = NewsCategory.NPB;

  @IsNotEmpty({ message: '見出しを設定してください' })
  @IsString({ message: '見出しは文字列である必要があります' })
  @Length(30, 50, { message: '見出しは30文字以上38文字以内で設定してください' })
  header: string;

  @IsNotEmpty({ message: 'サブ見出しを設定してください' })
  @IsString({ message: 'サブ見出しは文字列である必要があります' })
  @Length(35, 60, {
    message: 'サブ見出しは35文字以上45文字以内で設定してください',
  })
  subheader: string;

  @IsNotEmpty({ message: '本文を設定してください' })
  @IsString({ message: '本文は文字列である必要があります' })
  @Length(100, 600, { message: '本文は100文字以上500以内で設定してください' })
  body: string;

  @IsNotEmpty({ message: '概要を設定してください' })
  @IsString({ message: '概要は文字列である必要があります' })
  @Length(120, 300, { message: '概要は120文字以上180以内で設定してください' })
  summary: string;

  @IsNotEmpty({ message: '参考元の名前を設定してください' })
  @IsString({ message: '参考元の名前は文字列である必要があります' })
  @Length(1, 200, { message: '参考元の名前は100以内で設定してください' })
  reference_name: string;

  @IsNotEmpty({ message: '参考元のURLを設定してください' })
  @IsString({ message: '参考元のURLは文字列である必要があります' })
  @IsUrl({}, { message: '参考元のURL形式が不正です' })
  @Length(1, 600, { message: '参考元のURLは500以内で設定してください' })
  reference_url: string;

  // フロント/スクレイパーからは文字列で来ることが多いので Date ではなく文字列推奨
  @IsNotEmpty({ message: '参考元の発行日を設定してください' })
  @IsDateString(
    {},
    {
      message:
        '参考元の発行日はISO形式(例: 2026-01-14T00:00:00Z)で指定してください'
    },
  )
  reference_published_at: string;
}
