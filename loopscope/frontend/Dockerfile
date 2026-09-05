FROM node:latest
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN npm install --registry="${NPM_CONFIG_REGISTRY}"
COPY . .
EXPOSE 4319
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
