import { NewsCategory } from 'src/enums/news/news-category.enum';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('news')
@Index(['category'])
@Index(['created_at'])
export class News {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    type: 'enum',
    enum: NewsCategory,
    default: NewsCategory.NPB,
    nullable: false,
  })
  category: NewsCategory;

  @Column({
    type: 'varchar',
    length: 50,
    nullable: false,
  })
  header: string;

  @Column({
    type: 'varchar',
    length: 60,
    nullable: false,
  })
  subheader: string;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: false,
  })
  body: string;

  @Column({
    type: 'varchar',
    length: 200,
    nullable: false,
  })
  summary: string;

  @Column({
    type: 'varchar',
    length: 100,
    nullable: false,
  })
  reference_name: string;

  @Column({
    type: 'varchar',
    length: 500,
    nullable: false,
    unique: true,
  })
  reference_url: string;

  @Column({
    type: 'timestamptz',
    nullable: false,
  })
  reference_published_at: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
