import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

export default defineConfig({
	plugins: [
		tailwindcss(),
		paraglideVitePlugin({
			project: './project.inlang',
			outdir: './src/lib/paraglide',
			emitTsDeclarations: true,
			// No URL strategy: Nightwatch is an internal dashboard, so locale-prefixed routes would
			// only add noise (and would force a `reroute` hook). English stays the base locale.
			strategy: ['cookie', 'preferredLanguage', 'baseLocale']
		}),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	server: {
		// Fixed port so a `tailscale serve` proxy can sit in front of it, and fail loudly instead
		// of silently hopping to another port. `.ts.net` rather than the FQDN keeps the personal
		// tailnet name out of the repository.
		port: 5175,
		strictPort: true,
		allowedHosts: ['.ts.net']
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					// The database-backed suites share one Postgres — CI provides a single throwaway
					// instance — and the ingestion tests have to commit rather than roll back, because
					// what they assert *is* the commit (claiming a row, conflict handling). Two files
					// doing that at once collide. The whole suite runs in well under a second, so
					// serialising files costs nothing and removes the flake at its source.
					fileParallelism: false
				}
			}
		]
	}
});
