#!/bin/sh

echo "Waiting for PostgreSQL to be ready..."
# Simple wait loop (can be enhanced with pg_isready if postgresql-client is installed)
sleep 3

echo "Running database migrations..."
npm run db:deploy

echo "Starting Fastify server..."
npm start
