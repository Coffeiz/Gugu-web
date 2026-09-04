FROM node:22-alpine
RUN apk upgrade --no-cache
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 4319
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
