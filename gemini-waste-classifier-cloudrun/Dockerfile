FROM node:22.23.5-bookworm-slim@sha256:47725aca53d3295ec2d3be8f62726599b3033cc262edc2c7e429909b3ac599fc

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY server.js cropRecognition.js wholeImageRecognition.js wasteItemAssessment.js ./

USER node
EXPOSE 8080
CMD ["node", "server.js"]
