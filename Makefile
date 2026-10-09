# Katnor local dev without Docker. Reads .env from repo root.
-include .env
export

SERVER_PORT ?= 3010
WEB_PORT ?= 3011
PUBLIC_SERVER_URL ?= http://localhost:$(SERVER_PORT)

.PHONY: help install db-generate db-migrate db-post-migrate db-setup dev dev-server dev-worker dev-web

help:
	@echo "install          pnpm install"
	@echo "db-setup         generate + migrate + post-migrate"
	@echo "dev              server + worker + web via dev-local.sh"
	@echo "dev-server       @katnor/server only (port SERVER_PORT=$(SERVER_PORT))"
	@echo "dev-worker       @katnor/worker only"
	@echo "dev-server dev-worker dev-web need ./.env sourced first"

install:
	pnpm install

db-generate:
	pnpm --filter @katnor/db db:generate

db-migrate:
	pnpm --filter @katnor/db db:migrate

db-post-migrate:
	pnpm --filter @katnor/db db:post-migrate

db-setup: db-generate db-migrate db-post-migrate

dev:
	./dev-local.sh

dev-server:
	pnpm --filter @katnor/server dev

dev-worker:
	pnpm --filter @katnor/worker dev

dev-web:
	pnpm --filter @katnor/web dev -- --port $(WEB_PORT)
