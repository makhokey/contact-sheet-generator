# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a contact sheet generator built with React + Vite + Hono + Cloudflare Workers. Despite the generic template name in package.json ("vite-react-template"), the actual project is configured as "contact-sheet-generator" in wrangler.json.

## Development Commands

- **Start development server**: `npm run dev` (serves at http://localhost:5173)
- **Build for production**: `npm run build` (runs TypeScript compilation + Vite build)
- **Lint code**: `npm run lint` (ESLint with React hooks and refresh plugins)
- **Preview production build**: `npm run preview`
- **Deploy to Cloudflare**: `npm run deploy`
- **Dry run deployment**: `npm run check` (TypeScript check + build + dry-run deploy)
- **Generate Cloudflare types**: `npm run cf-typegen`

## Workflow Recommendations

- Use pnpm for package installs

## Architecture

### Frontend (React)
- **Entry point**: `src/react-app/main.tsx`
- **Main component**: `src/react-app/App.tsx`
- **Build target**: Client-side React app served as static assets

### Backend (Hono Worker)
- **Entry point**: `src/worker/index.ts`
- **API routes**: Currently has `/api/` endpoint returning `{name: "Cloudflare"}`
- **Runtime**: Cloudflare Workers with Node.js compatibility

### Build Configuration
- **Vite config**: Uses React plugin + Cloudflare plugin
- **TypeScript**: Multiple tsconfig files for different targets (app, worker, node)
- **Assets**: Built client files served from `./dist/client` as SPA

### Deployment
- **Platform**: Cloudflare Workers
- **Configuration**: `wrangler.json` with observability enabled and source maps
- **Assets handling**: Single-page application routing for client-side routing

## Key Dependencies

- **Runtime**: React 19, Hono 4.8.2
- **Build**: Vite 6.x, TypeScript 5.8.3
- **Deployment**: Wrangler 4.x, @cloudflare/vite-plugin
- **Linting**: ESLint 9.x with React hooks and refresh plugins