import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // エンドポイント設定
  app.setGlobalPrefix('baseball-news');

  // CORS設定
  app.enableCors();

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
