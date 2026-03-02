import { DataSource } from 'typeorm';
import { News } from './entities/news.entity';

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_DATABASE || 'baseball_news',
  entities: [
    News
  ],
  migrations: ['src/migrations/*.ts'],
  synchronize: false,
});

export default AppDataSource;
