/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import page from "./page.html?raw";
import { writeMinutes, type Hints, type MinutesT, type Org } from "./minutes";

const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (msg: string, status = 400) => json({ error: msg }, status);

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT, date TEXT, created_at INTEGER,
	   status TEXT, error TEXT, minutes TEXT, cost REAL)`,
	`CREATE TABLE IF NOT EXISTS pieces (meeting_id TEXT, idx INTEGER, start_s REAL, end_s REAL, text TEXT,
	   PRIMARY KEY (meeting_id, idx))`,
	`CREATE TABLE IF NOT EXISTS actions (meeting_id TEXT, key TEXT, type TEXT, status TEXT, data TEXT,
	   PRIMARY KEY (meeting_id, key))`,
	`CREATE TABLE IF NOT EXISTS hints (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT, updated_at INTEGER)`,
];
let schemaReady = false;
async function db() {
	if (!schemaReady) { await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s))); schemaReady = true; }
	return env.DB;
}

function org(): Org {
	try { return JSON.parse(env.ORG_CONFIG); }
	catch { return { org_name: "Our team", org_description: "a small organization", staff: [], vocabulary: [] }; }
}

// constant-time-ish comparison for the team code
function codeOk(req: Request) {
	const got = (req.headers.get("x-team-code") || "").trim().toLowerCase();
	const want = (env.TEAM_CODE || "").trim().toLowerCase();
	if (!want || got.length !== want.length) return false;
	let d = 0;
	for (let i = 0; i < want.length; i++) d |= got.charCodeAt(i) ^ want.charCodeAt(i);
	return d === 0;
}

// ---------- handlers ----------
async function createMeeting(req: Request) {
	const b = await req.json<{ title?: string; date?: string }>();
	const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date! : new Date().toISOString().slice(0, 10);
	const id = `${date}-${crypto.randomUUID().slice(0, 8)}`;
	await (await db()).prepare("INSERT INTO meetings (id, title, date, created_at, status) VALUES (?, ?, ?, ?, 'recording')")
		.bind(id, (b.title || "Meeting").slice(0, 120), date, Date.now()).run();
	return json({ id });
}

// One ~1-minute piece of audio: body = base64 WAV (16 kHz mono) as plain text, so the Worker does no heavy work.
async function addPiece(req: Request, id: string, idx: number) {
	const url = new URL(req.url);
	const start = Number(url.searchParams.get("start") || 0), end = Number(url.searchParams.get("end") || 0);
	const prev = (url.searchParams.get("prev") || "").slice(-200);
	const audio = await req.text();
	if (!audio || audio.length > 12_000_000) return err("Audio piece missing or too large");
	const o = org();
	const names = o.staff.map(s => s.name).join(", ");
	const prompt = `${o.org_name} staff meeting with ${names}. Topics: ${o.vocabulary.join(", ")}. ${prev}`.slice(0, 800);
	// Cloudflare Whisper first (free daily allowance); Groq Whisper if it fails or ?engine=groq forces it.
	let text = "", engine = "cloudflare", cfError = "";
	if (url.searchParams.get("engine") !== "groq") {
		try {
			const out = await env.AI.run(WHISPER, {
				audio, language: "en", task: "transcribe", initial_prompt: prompt,
				vad_filter: true, condition_on_previous_text: false,
			}) as { text?: string };
			text = (out.text || "").trim();
		} catch (e) {
			cfError = e instanceof Error ? e.message : String(e);
		}
	}
	if (url.searchParams.get("engine") === "groq" || cfError) {
		if (!env.GROQ_API_KEY) return err(`Transcription failed: ${cfError || "no Groq key set"}`, 502);
		text = await groqTranscribe(audio, `Staff meeting with ${names}. ${prev}`);
		engine = "groq";
	}
	await (await db()).prepare("INSERT OR REPLACE INTO pieces (meeting_id, idx, start_s, end_s, text) VALUES (?, ?, ?, ?, ?)")
		.bind(id, idx, start, end, text).run();
	return json({ idx, text, engine });
}

// Groq's hosted Whisper (OpenAI-compatible). Tested 2026-11-10: a short names-only prompt beats the long one,
// and turbo spelled staff names better than full large-v3.
async function groqTranscribe(audioB64: string, prompt: string) {
	const fromB64 = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
	const bytes = fromB64 ? fromB64(audioB64) : Uint8Array.from(atob(audioB64), c => c.charCodeAt(0));
	const form = new FormData();
	form.append("file", new Blob([bytes], { type: "audio/wav" }), "piece.wav");
	form.append("model", env.GROQ_MODEL || "whisper-large-v3-turbo");
	form.append("language", "en");
	form.append("temperature", "0");
	form.append("response_format", "json");
	form.append("prompt", prompt.slice(0, 500)); // Groq caps the prompt at 224 tokens
	let last = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
			method: "POST", headers: { authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form,
		});
		if (r.ok) return ((await r.json<{ text?: string }>()).text || "").trim();
		last = `Groq ${r.status}: ${(await r.text()).slice(0, 200)}`;
		if (r.status !== 429 && r.status < 500) break;
		await new Promise(res => setTimeout(res, 2000));
	}
	throw new Error(last);
}

async function finish(id: string) {
	const d = await db();
	const m = await d.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<Record<string, string>>();
	if (!m) return err("Not found", 404);
	const pieces = (await d.prepare("SELECT start_s, text FROM pieces WHERE meeting_id = ? ORDER BY idx").bind(id)
		.all<{ start_s: number; text: string }>()).results.filter(p => p.text);
	if (!pieces.length) {
		await d.prepare("UPDATE meetings SET status='error', error=? WHERE id=?").bind("Nothing was heard in the recording.", id).run();
		return err("Nothing was heard in the recording.");
	}
	await d.prepare("UPDATE meetings SET status='processing', error=NULL WHERE id=?").bind(id).run();
	try {
		const { minutes, cost } = await writeMinutes(env.ANTHROPIC_API_KEY, org(), m.title, m.date, pieces, await getHints());
		await d.batch([
			d.prepare("UPDATE meetings SET status='ready', minutes=?, cost=? WHERE id=?").bind(JSON.stringify(minutes), cost, id),
			d.prepare("DELETE FROM actions WHERE meeting_id=? AND status IN ('pending','approved','skipped')").bind(id),
			...buildActions(minutes).map(a => d.prepare(
				"INSERT OR IGNORE INTO actions (meeting_id, key, type, status, data) VALUES (?, ?, ?, 'pending', ?)")
				.bind(id, a.key, a.type, JSON.stringify(a.data))),
		]);
		return json({ ok: true });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await d.prepare("UPDATE meetings SET status='error', error=? WHERE id=?").bind(msg.slice(0, 500), id).run();
		return err(`Minutes failed: ${msg}`, 502);
	}
}

// Name hints (current leads, students, employers) are pushed from the CRM by the admin; one row, replaced whole.
async function getHints(): Promise<Hints | null> {
	const r = await (await db()).prepare("SELECT data FROM hints WHERE id = 1").first<{ data: string }>();
	try { return r ? JSON.parse(r.data) : null; } catch { return null; }
}

async function putHints(req: Request) {
	const b = await req.json<Partial<Hints>>().catch(() => null);
	const clean = (s: unknown) => typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 120) : "";
	const people = (Array.isArray(b?.people) ? b!.people : []).map(p => ({ name: clean(p?.name), note: clean(p?.note) }))
		.filter(p => p.name).slice(0, 2000);
	const employers = (Array.isArray(b?.employers) ? b!.employers : []).map(clean).filter(Boolean).slice(0, 2000);
	if (!people.length && !employers.length) return err("Send { people: [{name, note}], employers: [name] }");
	await (await db()).prepare("INSERT OR REPLACE INTO hints (id, data, updated_at) VALUES (1, ?, ?)")
		.bind(JSON.stringify({ people, employers }), Date.now()).run();
	return json({ people: people.length, employers: employers.length });
}

function buildActions(mn: MinutesT) {
	const out: { key: string; type: string; data: unknown }[] = [];
	for (const a of mn.action_items) out.push({ key: a.id, type: "task", data: a });
	mn.follow_up_meetings.forEach((f, i) => out.push({ key: `F${i + 1}`, type: "meeting", data: f }));
	out.push({ key: "EMAIL", type: "email", data: { subject: mn.recap_email_subject, body: mn.recap_email_body } });
	return out;
}

async function listMeetings() {
	const r = await (await db()).prepare(`SELECT m.id, m.title, m.date, m.status, m.created_at,
	   (SELECT COUNT(*) FROM actions a WHERE a.meeting_id = m.id AND a.type='task') AS tasks,
	   (SELECT COUNT(*) FROM actions a WHERE a.meeting_id = m.id AND a.status='approved') AS approved
	   FROM meetings m ORDER BY m.created_at DESC LIMIT 100`).all();
	return json(r.results);
}

async function getMeeting(id: string) {
	const d = await db();
	const m = await d.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<Record<string, unknown>>();
	if (!m) return err("Not found", 404);
	const pieces = (await d.prepare("SELECT idx, start_s, end_s, text FROM pieces WHERE meeting_id=? ORDER BY idx").bind(id).all()).results;
	const actions = (await d.prepare("SELECT key, type, status, data FROM actions WHERE meeting_id=? ORDER BY rowid").bind(id).all<{ key: string; type: string; status: string; data: string }>())
		.results.map(a => ({ key: a.key, type: a.type, status: a.status, ...JSON.parse(a.data) }));
	return json({ ...m, minutes: m.minutes ? JSON.parse(m.minutes as string) : null, pieces, actions });
}

async function updateAction(req: Request, id: string, key: string) {
	const b = await req.json<Record<string, unknown>>();
	const d = await db();
	const row = await d.prepare("SELECT status, data FROM actions WHERE meeting_id=? AND key=?").bind(id, key).first<{ status: string; data: string }>();
	if (!row) return err("Not found", 404);
	if (["created", "sent"].includes(row.status)) return err("Already done", 409);
	const data = JSON.parse(row.data);
	for (const f of ["task", "owner", "due_date", "priority", "title", "date", "start_time", "subject", "body"])
		if (typeof b[f] === "string") data[f] = (b[f] as string).slice(0, 5000);
	const status = ["pending", "approved", "skipped"].includes(b.status as string) ? b.status as string : row.status;
	await d.prepare("UPDATE actions SET status=?, data=? WHERE meeting_id=? AND key=?").bind(status, JSON.stringify(data), id, key).run();
	return json({ key, status, ...data });
}

// ---------- router ----------
export default {
	async fetch(req: Request) {
		const url = new URL(req.url);
		const p = url.pathname;
		if (p === "/" || p === "/index.html")
			return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
		if (!p.startsWith("/api/")) return new Response("Not found", { status: 404 });
		if (!codeOk(req)) return err("Wrong or missing team code", 401);
		try {
			let m: RegExpMatchArray | null;
			if (p === "/api/check") return json({ ok: true, org_name: org().org_name, staff: org().staff.map(s => s.name) });
			if (p === "/api/hints" && req.method === "PUT") return putHints(req);
			if (p === "/api/hints" && req.method === "GET") {
				const h = await getHints();
				return json({ people: h?.people?.length || 0, employers: h?.employers?.length || 0 });
			}
			if (p === "/api/meetings" && req.method === "GET") return listMeetings();
			if (p === "/api/meetings" && req.method === "POST") return createMeeting(req);
			if ((m = p.match(/^\/api\/meetings\/([\w-]+)$/)) && req.method === "GET") return getMeeting(m[1]);
			if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/pieces\/(\d+)$/)) && req.method === "POST") return addPiece(req, m[1], Number(m[2]));
			if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/finish$/)) && req.method === "POST") return finish(m[1]);
			if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/actions\/([\w-]+)$/)) && req.method === "POST") return updateAction(req, m[1], m[2]);
			return err("Unknown route", 404);
		} catch (e) {
			return err(e instanceof Error ? e.message : String(e), 500);
		}
	},
} satisfies ExportedHandler;
