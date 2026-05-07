FROM node:22-alpine

RUN apk add --no-cache bash curl && \
    addgroup -S proxy && adduser -S proxy -G proxy

WORKDIR /app
COPY proxy.js .

RUN chown -R proxy:proxy /app
USER proxy

EXPOSE 4446

CMD ["node", "proxy.js"]
