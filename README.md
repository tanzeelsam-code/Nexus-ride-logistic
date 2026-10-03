# NEXUS Logistics

## Full Stack AI-Powered Transportation Platform

NEXUS Logistics operates two verticals (NEXUS RIDE and NEXUS FREIGHT) using a shared AI brain, **NEXUS CORE**. This repository contains the complete frontend dashboard, backend API, AI Engine, Database schemas, and Docker configuration for running the entire platform locally.

### Tech Stack

- **Frontend:** Vanilla HTML/JS with custom CSS (Nginx)
- **Backend:** Node.js (Fastify/Express)
- **AI Engine:** Python (FastAPI, PyTorch)
- **Database:** PostgreSQL + TimescaleDB
- **Caching & Messaging:** Redis, Apache Kafka
- **Monitoring:** Prometheus + Grafana

### Getting Started

1. Ensure Docker Desktop is running.
2. Clone this repository.
3. Add any missing credentials to `.env`.
4. Run `docker compose up -d`.
5. Access the Operations Command Center dashboard at `http://localhost`.

### Dashboard Features

- Real-time driver fleet mapping
- AI dispatch performance metrics
- Active trips and delivery tracking
- Hourly revenue charting
- Live alerts and surge zone monitoring

*Move Everything. Intelligently.*
