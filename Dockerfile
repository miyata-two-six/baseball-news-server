# Node.js イメージを使用
FROM node:20-alpine

# 作業ディレクトリを設定
WORKDIR /app

# package.json と package-lock.json をコピー
COPY package*.json ./

RUN npm install

COPY . .
RUN npm run build

EXPOSE 3001

CMD ["npm", "run", "start:dev"]