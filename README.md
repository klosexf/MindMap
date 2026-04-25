# MindMap MVP

Single-user MVP implementation based on:
- AntV G6 (Mindmap preset)
- JSON Tree as single source of truth
- SVG/Canvas renderer switch (`<=800` svg, `>800` canvas)
- Zustand state management

## Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## API

- `POST /api/parse`
- `POST /api/generate` (SSE)
- `GET /api/mindmaps/:id`
- `PATCH /api/mindmaps/:id`
- `POST /api/export/markdown`
- `POST /api/export/png`

## Tests

```bash
npm run test
npm run typecheck
npm run lint
```
