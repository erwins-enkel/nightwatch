<script lang="ts">
	import {
		Activity,
		CalendarOff,
		CircleAlert,
		Inbox,
		Pause,
		Play,
		ShieldAlert,
		SlidersHorizontal,
		SquarePen,
		Triangle
	} from '@lucide/svelte';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Ampel from '$lib/components/Ampel.svelte';
	import Drawer from '$lib/components/Drawer.svelte';
	import LocaleSwitcher from '$lib/components/LocaleSwitcher.svelte';
	import Zeitachse from '$lib/components/Zeitachse.svelte';
	import { formatiereDauer, formatiereSekunden, formatiereZeitpunkt } from '$lib/board/zeit';
	import { m } from '$lib/paraglide/messages.js';
	import { getLocale } from '$lib/paraglide/runtime';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const locale = $derived(getLocale());
	const zeitpunkt = (wert: Date | string) => formatiereZeitpunkt(wert, data.zone, locale);
	const seit = (wert: Date | string) => formatiereDauer(wert, data.jetzt, locale);
	const dauer = (sekunden: number) => formatiereSekunden(sekunden, locale);

	const GRUND: Record<string, () => string> = {
		ueberfaellig: m.reason_overdue,
		fehler_gemeldet: m.reason_error_reported,
		unklar: m.reason_unclear,
		ereignis_eingetroffen: m.reason_event,
		paar_zu_lange_offen: m.reason_pair_open,
		zaehler_ueber_obergrenze: m.reason_above_upper,
		zaehler_unter_untergrenze: m.reason_below_lower
	};

	const ART: Record<string, () => string> = {
		heartbeat: m.kind_heartbeat,
		ereignis: m.kind_event,
		paar: m.kind_pair,
		zaehler: m.kind_counter
	};

	const ZUSTAND: Record<string, () => string> = {
		gestoert: m.state_disturbed,
		pausiert: m.state_paused,
		entwurf: m.state_draft,
		gesund: m.state_healthy
	};

	const TRIAGE_GRUND: Record<string, () => string> = {
		kein_kunde: m.triage_no_customer,
		mehrdeutig: m.triage_ambiguous,
		kein_monitor: m.triage_no_monitor
	};

	const QUELLE: Record<string, () => string> = {
		manuell: m.rule_source_manual,
		vorlage: m.rule_source_template,
		abgeleitet: m.rule_source_derived
	};

	/**
	 * Die Muster-Slots heißen je Monitor-Art anders — eine Struktur, vier Lesarten (CONTEXT
	 * „Regel"). Der Zähler liest sie gar nicht, deshalb steht dort nichts.
	 */
	const SLOTS: Record<string, { schlecht?: () => string; gut?: () => string }> = {
		heartbeat: { schlecht: m.slot_error, gut: m.slot_ok },
		ereignis: { gut: m.slot_harmless },
		paar: { schlecht: m.slot_open, gut: m.slot_close },
		zaehler: {}
	};

	/** Ein Link auf dieselbe Seite mit geänderten Parametern — die Schublade *ist* die URL. */
	function href(aenderungen: Record<string, string | null>) {
		const paare = [...page.url.searchParams].filter(([schluessel]) => !(schluessel in aenderungen));
		for (const [schluessel, wert] of Object.entries(aenderungen)) {
			if (wert !== null) paare.push([schluessel, wert]);
		}

		const abfrage = paare
			.map(([schluessel, wert]) => `${encodeURIComponent(schluessel)}=${encodeURIComponent(wert)}`)
			.join('&');

		return abfrage === '' ? resolve('/') : resolve(`/?${abfrage}`);
	}

	const zu = href({ monitor: null, kunde: null });
	const detail = $derived(data.monitorDetail);
	const kunde = $derived(data.kundenDetail);

	const abschnitt = 'text-xs font-semibold tracking-wider text-slate-500 uppercase';
	const karteKlasse =
		'flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4 text-left hover:border-emerald-700';
	const knopfKlasse =
		'rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500';
	const feldKlasse =
		'rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none';
</script>

<svelte:head><title>{m.board_title()} · Nightwatch</title></svelte:head>

<div class="min-h-screen">
	<header class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-slate-800 px-6 py-4">
		<h1 class="flex items-center gap-2 text-lg font-semibold text-slate-50">
			<Activity class="size-5 text-emerald-400" aria-hidden="true" />
			Nightwatch
		</h1>
		<p class="text-sm text-slate-400">{m.board_title()} · {zeitpunkt(data.jetzt)}</p>
		<nav class="ml-auto flex flex-wrap items-center gap-4 text-sm">
			<a class="text-slate-300 hover:text-emerald-300" href={resolve('/kunden')}>
				{m.customers_link()}
			</a>
			<a class="text-slate-300 hover:text-emerald-300" href={resolve('/einstellungen/postfaecher')}>
				{m.settings_mailboxes_link()}
			</a>
			<a class="text-slate-300 hover:text-emerald-300" href={resolve('/einstellungen/autotask')}>
				{m.settings_autotask_link()}
			</a>
			<a class="text-slate-300 hover:text-emerald-300" href={resolve('/einstellungen/webhooks')}>
				{m.settings_webhooks_link()}
			</a>
			<a
				class="text-slate-300 hover:text-emerald-300"
				href={resolve('/einstellungen/selbstueberwachung')}
			>
				{m.settings_self_link()}
			</a>
			<LocaleSwitcher />
		</nav>
	</header>

	<main class="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8">
		{#if form?.fehler}
			<p class="rounded border border-rose-900 bg-rose-950/40 px-4 py-2 text-sm text-rose-300">
				{form.fehler === 'kein_alarm' ? m.board_no_open_alarm() : m.board_action_failed()}
			</p>
		{/if}

		<!-- System-Banner ------------------------------------------------------------------- -->
		{#if data.system.gestoerte.length > 0 || data.system.unbeobachtet}
			<section
				class="flex flex-col gap-2 rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-3 text-sm text-amber-200"
				aria-label={m.system_banner_title()}
			>
				{#each data.system.gestoerte as selbst (selbst.id)}
					<p class="flex items-start gap-2">
						<ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>
							<b>{selbst.bezeichnung}</b> — {GRUND[selbst.alarmgrund ?? '']?.() ??
								selbst.alarmgrund}
							· {seit(selbst.zustandSeit)}
						</span>
					</p>
				{/each}
				{#if data.system.unbeobachtet}
					<p class="flex items-start gap-2">
						<ShieldAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						{m.self_unobserved()}
					</p>
				{/if}
				<a
					class="w-fit text-xs text-amber-300 underline underline-offset-4"
					href={resolve('/einstellungen/selbstueberwachung')}
				>
					{m.system_banner_link()}
				</a>
			</section>
		{/if}

		<!-- Suche & Filter ------------------------------------------------------------------ -->
		<form
			method="GET"
			action={resolve('/')}
			class="flex flex-wrap items-end gap-3 rounded-lg border border-slate-800 bg-slate-900/50 p-4"
		>
			<div class="flex min-w-56 flex-1 flex-col gap-1">
				<label class="text-xs text-slate-400" for="q">{m.board_search()}</label>
				<input
					class={feldKlasse}
					id="q"
					name="q"
					type="search"
					value={data.filter.suche}
					placeholder={m.board_search_hint()}
				/>
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-xs text-slate-400" for="zustand">{m.board_filter_state()}</label>
				<select class={feldKlasse} id="zustand" name="zustand">
					<option value="">{m.board_filter_any()}</option>
					{#each data.zustaende as zustand (zustand)}
						<option value={zustand} selected={data.filter.zustand === zustand}>
							{ZUSTAND[zustand]()}
						</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-col gap-1">
				<label class="text-xs text-slate-400" for="art">{m.board_filter_kind()}</label>
				<select class={feldKlasse} id="art" name="art">
					<option value="">{m.board_filter_any()}</option>
					{#each data.arten as art (art)}
						<option value={art} selected={data.filter.art === art}>{ART[art]()}</option>
					{/each}
				</select>
			</div>

			<button
				type="submit"
				class="flex items-center gap-2 rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
			>
				<SlidersHorizontal class="size-4" aria-hidden="true" />
				{m.board_filter_apply()}
			</button>
			<a class={knopfKlasse} href={resolve('/')}>{m.board_filter_reset()}</a>
		</form>

		<!-- Alarm-Leiste -------------------------------------------------------------------- -->
		<section class="flex flex-col gap-3">
			<h2 class={abschnitt}>{m.board_alarms({ anzahl: data.alarme.length })}</h2>

			{#each data.alarme as alarm (alarm.alertId)}
				<a
					href={href({ monitor: alarm.monitorId, kunde: null })}
					class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-l-4 border-rose-900/70 border-l-rose-500 bg-slate-900/60 px-4 py-3 hover:bg-slate-900"
				>
					<span class="flex min-w-40 items-center gap-2 text-sm font-semibold text-rose-300">
						<Triangle class="size-3 fill-current" aria-hidden="true" />
						{GRUND[alarm.alarmgrund]?.() ?? alarm.alarmgrund}
					</span>
					<span class="text-sm text-slate-200">
						<b class="font-semibold">{alarm.kundeName}</b> · {alarm.monitorBezeichnung}
					</span>
					{#if alarm.quittiertAm}
						<span class="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
							{m.board_acknowledged()}
						</span>
					{/if}
					{#if alarm.verschaerftAm}
						<span class="rounded bg-rose-950 px-2 py-0.5 text-xs text-rose-300">
							{m.board_escalated()}
						</span>
					{/if}
					{#if alarm.vorkommen > 1}
						<span class="text-xs text-slate-500">
							{m.board_occurrences({ anzahl: alarm.vorkommen })}
						</span>
					{/if}
					<span class="ml-auto text-xs text-slate-400 tabular-nums">
						{seit(alarm.begonnenAm)} · {zeitpunkt(alarm.begonnenAm)}
					</span>
				</a>
			{:else}
				<p class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400">
					{data.alarmeVerdeckt > 0 ? m.board_alarms_all_filtered() : m.board_alarms_none()}
				</p>
			{/each}

			{#if data.alarmeVerdeckt > 0 && data.alarme.length > 0}
				<p class="text-xs text-amber-300">
					{m.board_alarms_filtered({ anzahl: data.alarmeVerdeckt })}
				</p>
			{/if}
		</section>

		<!-- Kunden-Karten ------------------------------------------------------------------- -->
		<section class="flex flex-col gap-3">
			<h2 class={abschnitt}>{m.board_customers({ anzahl: data.karten.length })}</h2>

			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{#each data.karten as karte (karte.kunde.id)}
					<a href={href({ kunde: karte.kunde.id, monitor: null })} class={karteKlasse}>
						<span class="flex items-center gap-2">
							<Ampel zustand={karte.ampel} />
							<span class="font-medium text-slate-100">{karte.kunde.name}</span>
						</span>

						<span class="flex flex-wrap gap-x-3 gap-y-1">
							{#each data.zustaende as zustand (zustand)}
								{#if karte.zaehler[zustand] > 0}
									<Ampel {zustand} anzahl={karte.zaehler[zustand]} klein />
								{/if}
							{/each}
						</span>

						<span
							class="flex flex-wrap gap-x-3 border-t border-dashed border-slate-800 pt-2 text-xs text-slate-500"
						>
							<span>{m.board_monitors({ anzahl: karte.gesamt })}</span>
							<span>
								{karte.kunde.autotaskCompanyId === null
									? m.board_without_autotask()
									: m.board_with_autotask()}
							</span>
						</span>

						{#if karte.treffer.length > 0 && karte.treffer.length < karte.gesamt}
							<span class="flex flex-col gap-1 text-xs text-slate-400">
								{#each karte.treffer as monitor (monitor.id)}
									<span class="truncate">· {monitor.bezeichnung}</span>
								{/each}
							</span>
						{/if}
					</a>
				{:else}
					<p
						class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400 sm:col-span-2 lg:col-span-3"
					>
						{m.board_customers_none()}
					</p>
				{/each}
			</div>
		</section>

		<!-- System-Triage ------------------------------------------------------------------- -->
		<section class="flex flex-col gap-3">
			<h2 class={abschnitt}>{m.board_triage({ anzahl: data.triage.anzahl })}</h2>
			<p class="text-sm text-slate-400">{m.board_triage_hint()}</p>

			{#each data.triage.eintraege as eintrag (eintrag.id)}
				<article
					class="flex flex-wrap items-start gap-x-4 gap-y-1 rounded-lg border border-l-4 border-amber-900/60 border-l-amber-500 bg-slate-900/60 px-4 py-3"
				>
					<span class="flex min-w-48 items-center gap-2 text-xs font-semibold text-amber-300">
						<CircleAlert class="size-3.5" aria-hidden="true" />
						{TRIAGE_GRUND[eintrag.grund ?? '']?.() ?? eintrag.grund}
					</span>
					<span class="flex min-w-0 flex-col gap-0.5">
						<span class="text-sm text-slate-200">{eintrag.betreff}</span>
						<span class="font-mono text-xs text-slate-500">
							{eintrag.absender} · {zeitpunkt(eintrag.ankunftszeit)}
						</span>
						{#if eintrag.kandidaten.length > 0}
							<span class="text-xs text-slate-500">
								{m.triage_candidates()}: {eintrag.kandidaten.join(', ')}
							</span>
						{/if}
					</span>
				</article>
			{:else}
				<p class="rounded-lg border border-dashed border-slate-800 p-6 text-sm text-slate-400">
					{m.board_triage_none()}
				</p>
			{/each}

			{#if data.triage.anzahl > data.triage.eintraege.length}
				<p class="text-xs text-slate-500">
					{m.board_triage_more({
						anzahl: data.triage.anzahl - data.triage.eintraege.length
					})}
				</p>
			{/if}
		</section>
	</main>
</div>

<!-- Kunden-Drawer ------------------------------------------------------------------------- -->
<!--
	Höchstens eine Schublade auf einmal: eine von Hand gebaute URL mit beiden Parametern legte sonst
	zwei Dialoge übereinander. Der Monitor ist der spezifischere Zeiger und gewinnt.
-->
{#if kunde && !detail}
	<Drawer titel={kunde.kunde.name} schliessenHref={zu}>
		{#snippet kopf()}
			<span class="text-xs text-slate-500">{m.drawer_customer()}</span>
		{/snippet}

		<div class="flex flex-col gap-1 text-sm text-slate-400">
			{#if kunde.kunde.kundennummer}
				<span class="font-mono">{kunde.kunde.kundennummer}</span>
			{/if}
			{#if kunde.kunde.notiz}<span>{kunde.kunde.notiz}</span>{/if}
			<span>
				{kunde.kunde.autotaskCompanyId === null
					? m.board_without_autotask()
					: m.board_with_autotask()}
			</span>
			<a
				class="w-fit text-emerald-400 underline underline-offset-4"
				href={resolve('/kunden/[id]', { id: kunde.kunde.id })}
			>
				{m.drawer_customer_manage()}
			</a>
		</div>

		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.board_monitors({ anzahl: kunde.monitore.length })}</h3>
			{#each kunde.monitore as monitor (monitor.id)}
				<a
					href={href({ monitor: monitor.id, kunde: null })}
					class="flex items-center gap-3 rounded border border-slate-800 px-3 py-2 hover:border-emerald-700"
				>
					<span class="min-w-0 flex-1 truncate text-sm text-slate-100">{monitor.bezeichnung}</span>
					<span class="rounded border border-slate-700 px-1.5 py-0.5 text-xs text-slate-400">
						{ART[monitor.art]()}
					</span>
					<Ampel zustand={monitor.anzeige} klein />
				</a>
			{:else}
				<p class="text-sm text-slate-400">{m.board_no_monitors()}</p>
			{/each}
		</section>
	</Drawer>
{/if}

<!-- Monitor-Drawer ------------------------------------------------------------------------ -->
{#if detail}
	<Drawer titel={detail.bezeichnung} schliessenHref={zu}>
		{#snippet kopf()}
			<a
				class="text-xs text-emerald-400 hover:underline"
				href={href({ kunde: detail.kundeId, monitor: null })}
			>
				← {detail.kundeName}
			</a>
		{/snippet}

		<div class="flex flex-wrap items-center gap-3">
			<Ampel zustand={detail.anzeige} />
			<span class="rounded border border-slate-700 px-1.5 py-0.5 text-xs text-slate-400">
				{ART[detail.art]()}
			</span>
			{#if detail.pauseWirksam && detail.anzeige !== 'pausiert'}
				<Ampel zustand="pausiert" klein />
			{/if}
			<span class="text-xs text-slate-500">{m.monitor_since()} {seit(detail.zustandSeit)}</span>
		</div>

		{#if detail.aktiviertAm === null}
			<p class="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
				{m.monitor_draft_hint()}
			</p>
		{/if}

		<!-- Zustand & Alarmgrund -->
		{#if detail.episode}
			<section class="flex flex-col gap-2 rounded border border-rose-900/60 bg-rose-950/20 p-3">
				<h3 class={abschnitt}>{m.monitor_reason()}</h3>
				<p class="text-sm text-rose-200">
					<b>{GRUND[detail.episode.alarmgrund]?.() ?? detail.episode.alarmgrund}</b>
					· {m.monitor_since()}
					{zeitpunkt(detail.episode.begonnenAm)}
					{#if detail.episode.vorkommen > 1}
						· {m.board_occurrences({ anzahl: detail.episode.vorkommen })}
					{/if}
				</p>
				<p class="font-mono text-xs text-slate-500">
					{m.monitor_alert_id()}: {detail.episode.alertId}
				</p>
				{#if detail.empfehlung}
					<p class="text-xs text-slate-400">
						{detail.empfehlung === 'regel_ueberarbeiten'
							? m.monitor_advice_rule()
							: m.monitor_advice_fix()}
					</p>
				{/if}

				<form method="POST" action="?/quittieren" use:enhance class="flex gap-2">
					<input type="hidden" name="monitorId" value={detail.id} />
					<input
						type="hidden"
						name="quittiert"
						value={detail.episode.quittiertAm ? 'false' : 'true'}
					/>
					<button type="submit" class={knopfKlasse}>
						{detail.episode.quittiertAm ? m.monitor_unacknowledge() : m.monitor_acknowledge()}
					</button>
					{#if detail.episode.quittiertAm}
						<span class="self-center text-xs text-slate-500">
							{m.board_acknowledged()} · {zeitpunkt(detail.episode.quittiertAm)}
						</span>
					{/if}
				</form>
			</section>
		{/if}

		<!-- 7-Tage-Zeitachse -->
		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.monitor_timeline()}</h3>
			<p class="text-xs text-slate-500">
				{#if detail.art === 'heartbeat' && detail.erwartungModus === 'intervall' && detail.erwartungIntervallSekunden !== null}
					{m.monitor_expect_interval({ intervall: dauer(detail.erwartungIntervallSekunden) })}
				{:else if detail.art === 'heartbeat' && detail.erwartungPlan}
					{m.monitor_expect_plan({ uhrzeit: detail.erwartungPlan.uhrzeit })}
				{:else if detail.art === 'ereignis' && detail.autoZurueckSekunden !== null}
					{m.monitor_expect_event({ dauer: dauer(detail.autoZurueckSekunden) })}
				{:else if detail.art === 'paar' && detail.maxOffenzeitSekunden !== null}
					{m.monitor_expect_pair({ dauer: dauer(detail.maxOffenzeitSekunden) })}
				{:else if detail.art === 'zaehler' && detail.zaehlerFensterSekunden !== null}
					{m.monitor_expect_counter({
						fenster: dauer(detail.zaehlerFensterSekunden),
						unten: detail.zaehlerUntergrenze ?? '—',
						oben: detail.zaehlerObergrenze ?? '—'
					})}
				{/if}
				{#if detail.karenzSekunden !== null}
					· {m.monitor_grace()}: {dauer(detail.karenzSekunden)}
				{/if}
			</p>
			<Zeitachse spalten={detail.spalten} />
			{#if detail.zuletztGesehenAm}
				<p class="text-xs text-slate-500">
					{m.monitor_last_seen()}: {zeitpunkt(detail.zuletztGesehenAm)}
				</p>
			{/if}
		</section>

		<!-- Pausieren -->
		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.monitor_pause()}</h3>
			{#if detail.pauseWirksam}
				<p class="text-xs text-slate-400">
					{detail.pausiertBis
						? m.monitor_paused_until({ zeitpunkt: zeitpunkt(detail.pausiertBis) })
						: m.monitor_paused_open()}
				</p>
				<form method="POST" action="?/pause" use:enhance>
					<input type="hidden" name="monitorId" value={detail.id} />
					<input type="hidden" name="pausiert" value="false" />
					<button type="submit" class="{knopfKlasse} flex items-center gap-2">
						<Play class="size-3.5" aria-hidden="true" />
						{m.monitor_resume()}
					</button>
				</form>
			{:else}
				<p class="text-xs text-slate-500">{m.monitor_pause_hint()}</p>
				<form method="POST" action="?/pause" use:enhance class="flex flex-wrap items-end gap-2">
					<input type="hidden" name="monitorId" value={detail.id} />
					<input type="hidden" name="pausiert" value="true" />
					<label class="flex flex-col gap-1 text-xs text-slate-400">
						{m.monitor_pause_duration()}
						<select class={feldKlasse} name="dauerSekunden">
							{#each data.pauseDauern as sekunden (sekunden)}
								<option value={sekunden}>{dauer(sekunden)}</option>
							{/each}
							<option value="">{m.monitor_pause_open_ended()}</option>
						</select>
					</label>
					<button type="submit" class="{knopfKlasse} flex items-center gap-2">
						<Pause class="size-3.5" aria-hidden="true" />
						{m.monitor_pause()}
					</button>
				</form>
			{/if}
		</section>

		<!-- Ausnahmekalender -->
		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.monitor_calendars()}</h3>
			{#if detail.kalender.length === 0}
				<p class="flex items-center gap-2 text-xs text-slate-500">
					<CalendarOff class="size-3.5" aria-hidden="true" />
					{m.monitor_calendars_none()}
				</p>
			{:else}
				<form method="POST" action="?/kalender" use:enhance class="flex flex-col gap-2">
					<input type="hidden" name="monitorId" value={detail.id} />
					{#each detail.kalender as eintrag (eintrag.id)}
						<label class="flex items-center gap-2 text-sm text-slate-300">
							<input
								type="checkbox"
								name="kalender"
								value={eintrag.id}
								checked={eintrag.zugeordnet}
								class="size-4 accent-emerald-500"
							/>
							{eintrag.name}
						</label>
					{/each}
					<button type="submit" class="{knopfKlasse} w-fit">{m.monitor_calendars_save()}</button>
				</form>
			{/if}
		</section>

		<!-- Letzte zugeordnete Mails -->
		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.monitor_last_mails()}</h3>
			{#each detail.letzteMails as post (post.id)}
				<article class="flex flex-col gap-0.5 rounded border border-slate-800 px-3 py-2">
					<span class="flex items-start gap-2">
						<Inbox class="mt-0.5 size-3.5 shrink-0 text-slate-600" aria-hidden="true" />
						<span class="min-w-0 flex-1 text-sm text-slate-200">{post.betreff}</span>
						{#if post.klassifikation}
							<span
								class="shrink-0 rounded px-1.5 py-0.5 text-xs {post.klassifikation === 'fehler'
									? 'bg-rose-950 text-rose-300'
									: post.klassifikation === 'unklar'
										? 'bg-amber-950 text-amber-300'
										: 'bg-emerald-950 text-emerald-300'}"
							>
								{post.klassifikation === 'fehler'
									? m.day_error()
									: post.klassifikation === 'unklar'
										? m.day_unclear()
										: m.day_ok()}
							</span>
						{/if}
					</span>
					<span class="pl-5 font-mono text-xs text-slate-500">
						{post.absender} · {zeitpunkt(post.ankunftszeit)}
					</span>
				</article>
			{:else}
				<p class="text-sm text-slate-400">{m.monitor_no_mails()}</p>
			{/each}
		</section>

		<!-- Regel-Zusammenfassung -->
		<section class="flex flex-col gap-2">
			<h3 class={abschnitt}>{m.monitor_rule()}</h3>
			<dl class="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-sm">
				<dt class="text-slate-500">{m.rule_sender()}</dt>
				<dd class="min-w-0 font-mono break-words text-slate-300">
					{detail.regel.absender.join(' · ') || '—'}
				</dd>
				<dt class="text-slate-500">{m.rule_subject()}</dt>
				<dd class="min-w-0 font-mono break-words text-slate-300">
					{detail.regel.betreffMuster.join(' · ') || '—'}
				</dd>
				<dt class="text-slate-500">{m.rule_keywords()}</dt>
				<dd class="min-w-0 font-mono break-words text-slate-300">
					{detail.regel.schluesselwoerter.join(' · ') || '—'}
				</dd>
				{#if SLOTS[detail.art]?.schlecht}
					<dt class="text-slate-500">{SLOTS[detail.art]?.schlecht?.()}</dt>
					<dd class="min-w-0 font-mono break-words text-slate-300">
						{detail.regel.musterSchlecht.join(' · ') || '—'}
					</dd>
				{/if}
				{#if SLOTS[detail.art]?.gut}
					<dt class="text-slate-500">{SLOTS[detail.art]?.gut?.()}</dt>
					<dd class="min-w-0 font-mono break-words text-slate-300">
						{detail.regel.musterGut.join(' · ') || '—'}
					</dd>
				{/if}
				<dt class="text-slate-500">{m.rule_source()}</dt>
				<dd class="text-slate-300">{QUELLE[detail.regel.quelle]?.() ?? detail.regel.quelle}</dd>
			</dl>

			<a
				class="flex w-fit items-center gap-2 rounded border border-emerald-800 bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-600"
				href={resolve('/monitore/[id]/regel', { id: detail.id })}
			>
				<SquarePen class="size-3.5" aria-hidden="true" />
				{m.monitor_rule_edit()}
			</a>
		</section>
	</Drawer>
{/if}
