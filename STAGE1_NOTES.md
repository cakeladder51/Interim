# Stage 1 Implementation Notes

## Next.js Configuration

The following `next.config.ts` options are default from `create-next-app@16.4.3`:
- `cacheComponents: true` - Default caching behavior for Next.js 16
- `partialPrefetching: true` - Default prefetching behavior for Next.js 16
- Turbopack CSS rule for `@tailwindcss/turbopack` - Default Tailwind CSS v4 integration

The `export const runtime = "nodejs"` directive specified in the brief cannot be used because Next.js 16 with `cacheComponents: true` rejects it with:

```
Error: Route segment config "runtime" is not compatible with `nextConfig.cacheComponents`. Please remove it.
```

This is a Next.js 16 breaking change. The route runs on Node.js by default in the App Router.

## zod Version

The project uses `zod@^4.0.0` (currently `zod@4.6.7`) throughout:
- All imports use `"zod"` (not the `/v4` subpath)
- `toJSONSchema` from zod is used for Structured Output schema generation

## Known Deviations from Brief

1. **`export const runtime = "nodejs"`** - Cannot be used with `cacheComponents: true` in Next.js 16
2. **Contracts module path** - Uses `"zod"` for all imports (zod v4 standard import)

## Latency Script Notes

The latency script:
- Uses `maxRetries: 0` for accurate latency measurements
- Uses a realistic ~1.5k token prompt with transcript context
- Reports `prompt_tokens` in the output table
- Handles 4xx image rejection gracefully
