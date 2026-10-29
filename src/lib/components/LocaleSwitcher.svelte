<script lang="ts">
	import { ToggleGroup } from 'bits-ui';
	import { getLocale, locales, setLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	// `setLocale` persists the choice in a cookie and reloads, so the server renders the new
	// locale too. No URL prefixes are involved — see the strategy in vite.config.ts.
	function select(value: string) {
		if (value && value !== getLocale()) setLocale(value as (typeof locales)[number]);
	}
</script>

<div class="flex items-center gap-2">
	<span class="text-sm text-slate-400">{m.language()}</span>
	<ToggleGroup.Root
		type="single"
		value={getLocale()}
		onValueChange={select}
		aria-label={m.language()}
		class="flex overflow-hidden rounded-md border border-slate-700"
	>
		{#each locales as locale (locale)}
			<ToggleGroup.Item
				value={locale}
				class="px-3 py-1 text-sm text-slate-300 uppercase data-[state=on]:bg-slate-700 data-[state=on]:text-slate-50"
			>
				{locale}
			</ToggleGroup.Item>
		{/each}
	</ToggleGroup.Root>
</div>
