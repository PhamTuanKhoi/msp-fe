# Bước 1: Build React app
FROM node:20 AS build

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Bước 2: Serve app với serve (port 3000)
FROM node:20-slim

WORKDIR /app
RUN npm install -g serve

# copy dist từ stage build
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["serve", "-s", "dist", "-l", "3000"]
