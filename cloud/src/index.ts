/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import page from "./page.html?raw";
import { writeMinutes, type Hints, type MinutesT, type Org } from "./minutes";
import { callback, currentUser, login, logout, staffByEmail, type User } from "./auth";
import { handleMcp } from "./mcp";

const WHISPER = "@cf/openai/whisper-large-v3-turbo";
export const json = (data: unknown, status = 200) => Response.json(data, { status });
export const err = (msg: string, status = 400) => json({ error: msg }, status);
export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, title TEXT, date TEXT, created_at INTEGER,
	   status TEXT, error TEXT, minutes TEXT, cost REAL)`,
	`CREATE TABLE IF NOT EXISTS pieces (meeting_id TEXT, idx INTEGER, start_s REAL, end_s REAL, text TEXT,
	   PRIMARY KEY (meeting_id, idx))`,
	`CREATE TABLE IF NOT EXISTS actions (meeting_id TEXT, key TEXT, type TEXT, status TEXT, data TEXT,
	   PRIMARY KEY (meeting_id, key))`,
	`CREATE TABLE IF NOT EXISTS hints (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT, updated_at INTEGER)`,
	`CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT, created_at INTEGER, expires_at INTEGER)`,
];
// Columns added after the first release; existing meetings default to "everyone".
const MEETING_COLUMNS: Record<string, string> = {
	visibility: "TEXT DEFAULT 'everyone'", viewers: "TEXT DEFAULT '[]'", created_by: "TEXT DEFAULT ''",
};
let schemaReady = false;
export async function db() {
	if (!schemaReady) {
		await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
		const cols = new Set((await env.DB.prepare("SELECT name FROM pragma_table_info('meetings')").all<{ name: string }>()).results.map(r => r.name));
		for (const [c, def] of Object.entries(MEETING_COLUMNS))
			if (!cols.has(c)) await env.DB.prepare(`ALTER TABLE meetings ADD COLUMN ${c} ${def}`).run();
		schemaReady = true;
	}
	return env.DB;
}

export function org(): Org {
	try { return JSON.parse(env.ORG_CONFIG); }
	catch { return { org_name: "Our team", org_description: "a small organization", staff: [], vocabulary: [] }; }
}

// ---------- access ----------
export type MeetingRow = { id: string; title: string; date: string; created_at: number; status: string; error: string | null;
	minutes: string | null; cost: number | null; visibility: string; viewers: string; created_by: string };

const viewersOf = (m: MeetingRow): string[] => { try { return JSON.parse(m.viewers || "[]"); } catch { return []; } };
export const canSee = (u: User, m: MeetingRow) =>
	u.all || m.visibility !== "private" || m.created_by === u.email || viewersOf(m).includes(u.email);
const canManage = (u: User, m: MeetingRow) => u.all || m.created_by === u.email;

// Only staff emails are accepted; the creator is always included in a private meeting.
function cleanAccess(o: Org, visibility: unknown, viewers: unknown, creator: string) {
	const vis = visibility === "private" ? "private" : "everyone";
	const list = (Array.isArray(viewers) ? viewers : []).map(v => String(v).toLowerCase()).filter(e => staffByEmail(o, e));
	if (vis === "private" && creator && staffByEmail(o, creator) && !list.includes(creator)) list.push(creator);
	return { visibility: vis, viewers: vis === "private" ? [...new Set(list)] : [] };
}

function accessInfo(o: Org, m: MeetingRow) {
	const name = (e: string) => staffByEmail(o, e)?.name || e;
	return {
		visibility: m.visibility || "everyone",
		viewers: viewersOf(m).map(e => ({ email: e, name: name(e) })),
		created_by: m.created_by ? { email: m.created_by, name: name(m.created_by) } : null,
		always_visible_to: o.staff.filter(s => s.access === "all").map(s => s.name),
	};
}

export async function loadMeeting(u: User, id: string) {
	const m = await (await db()).prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<MeetingRow>();
	if (!m || !canSee(u, m)) throw new HttpError(404, "Meeting not found"); // same answer for "hidden" and "missing"
	return m;
}

// ---------- meetings ----------
export async function createMeeting(u: User, b: { title?: string; date?: string; visibility?: string; viewers?: string[] }) {
	const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date! : new Date().toISOString().slice(0, 10);
	const id = `${date}-${crypto.randomUUID().slice(0, 8)}`;
	const a = cleanAccess(org(), b.visibility, b.viewers, u.email);
	await (await db()).prepare(`INSERT INTO meetings (id, title, date, created_at, status, visibility, viewers, created_by)
		VALUES (?, ?, ?, ?, 'recording', ?, ?, ?)`)
		.bind(id, (b.title || "Meeting").slice(0, 120), date, Date.now(), a.visibility, JSON.stringify(a.viewers), u.email).run();
	return { id, ...a };
}

export async function setAccess(u: User, id: string, b: { visibility?: string; viewers?: string[] }) {
	const m = await loadMeeting(u, id);
	if (!canManage(u, m)) throw new HttpError(403, "Only the person who started this meeting (or an admin) can change who sees it");
	const a = cleanAccess(org(), b.visibility, b.viewers, m.created_by);
	await (await db()).prepare("UPDATE meetings SET visibility = ?, viewers = ? WHERE id = ?").bind(a.visibility, JSON.stringify(a.viewers), id).run();
	return accessInfo(org(), { ...m, visibility: a.visibility, viewers: JSON.stringify(a.viewers) });
}

export async function updateMeeting(u: User, id: string, b: { title?: string; date?: string }) {
	const m = await loadMeeting(u, id);
	if (!canManage(u, m)) throw new HttpError(403, "Only the person who started this meeting (or an admin) can edit it");
	const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 120) : m.title;
	const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date! : m.date;
	await (await db()).prepare("UPDATE meetings SET title = ?, date = ? WHERE id = ?").bind(title, date, id).run();
	return { id, title, date };
}

export async function deleteMeeting(u: User, id: string) {
	if (!u.admin) throw new HttpError(403, "Admins only");
	await loadMeeting(u, id);
	const d = await db();
	await d.batch(["actions", "pieces"].map(t => d.prepare(`DELETE FROM ${t} WHERE meeting_id = ?`).bind(id))
		.concat(d.prepare("DELETE FROM meetings WHERE id = ?").bind(id)));
	return { deleted: id };
}

// One ~1-minute piece of audio: body = base64 WAV (16 kHz mono) as plain text, so the Worker does no heavy work.
async function addPiece(req: Request, u: User, id: string, idx: number) {
	await loadMeeting(u, id);
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

export async function finish(u: User, id: string) {
	const m = await loadMeeting(u, id);
	const d = await db();
	const pieces = (await d.prepare("SELECT start_s, text FROM pieces WHERE meeting_id = ? ORDER BY idx").bind(id)
		.all<{ start_s: number; text: string }>()).results.filter(p => p.text);
	if (!pieces.length) {
		await d.prepare("UPDATE meetings SET status='error', error=? WHERE id=?").bind("Nothing was heard in the recording.", id).run();
		throw new HttpError(400, "Nothing was heard in the recording.");
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
		return { ok: true, cost, tasks: minutes.action_items.length };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await d.prepare("UPDATE meetings SET status='error', error=? WHERE id=?").bind(msg.slice(0, 500), id).run();
		throw new HttpError(502, `Minutes failed: ${msg}`);
	}
}

// Name hints (current leads, students, employers) are pushed from the CRM by an admin; one row, replaced whole.
export async function getHints(): Promise<Hints | null> {
	const r = await (await db()).prepare("SELECT data FROM hints WHERE id = 1").first<{ data: string }>();
	try { return r ? JSON.parse(r.data) : null; } catch { return null; }
}

export async function putHints(u: User, b: Partial<Hints> | null) {
	if (!u.admin) throw new HttpError(403, "Admins only");
	const clean = (s: unknown) => typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 120) : "";
	const people = (Array.isArray(b?.people) ? b!.people : []).map(p => ({ name: clean(p?.name), note: clean(p?.note) }))
		.filter(p => p.name).slice(0, 2000);
	const employers = (Array.isArray(b?.employers) ? b!.employers : []).map(clean).filter(Boolean).slice(0, 2000);
	if (!people.length && !employers.length) throw new HttpError(400, "Send { people: [{name, note}], employers: [name] }");
	await (await db()).prepare("INSERT OR REPLACE INTO hints (id, data, updated_at) VALUES (1, ?, ?)")
		.bind(JSON.stringify({ people, employers }), Date.now()).run();
	return { people: people.length, employers: employers.length };
}

function buildActions(mn: MinutesT) {
	const out: { key: string; type: string; data: unknown }[] = [];
	for (const a of mn.action_items) out.push({ key: a.id, type: "task", data: a });
	mn.follow_up_meetings.forEach((f, i) => out.push({ key: `F${i + 1}`, type: "meeting", data: f }));
	out.push({ key: "EMAIL", type: "email", data: { subject: mn.recap_email_subject, body: mn.recap_email_body } });
	return out;
}

export async function listMeetings(u: User, limit = 100, status?: string) {
	const r = await (await db()).prepare(`SELECT m.id, m.title, m.date, m.status, m.created_at, m.visibility, m.viewers, m.created_by,
	   (SELECT COUNT(*) FROM actions a WHERE a.meeting_id = m.id AND a.type='task') AS tasks,
	   (SELECT COUNT(*) FROM actions a WHERE a.meeting_id = m.id AND a.status='approved') AS approved
	   FROM meetings m ORDER BY m.created_at DESC LIMIT 500`).all<MeetingRow & { tasks: number; approved: number }>();
	const o = org();
	return r.results.filter(m => canSee(u, m) && (!status || m.status === status)).slice(0, limit)
		.map(m => { const { viewers: _v, created_by: _c, ...rest } = m; return { ...rest, access: accessInfo(o, m) }; });
}

export async function getMeeting(u: User, id: string) {
	const m = await loadMeeting(u, id);
	const d = await db();
	const pieces = (await d.prepare("SELECT idx, start_s, end_s, text FROM pieces WHERE meeting_id=? ORDER BY idx").bind(id).all()).results;
	const actions = (await d.prepare("SELECT key, type, status, data FROM actions WHERE meeting_id=? ORDER BY rowid").bind(id).all<{ key: string; type: string; status: string; data: string }>())
		.results.map(a => ({ key: a.key, type: a.type, status: a.status, ...JSON.parse(a.data) }));
	const { viewers: _v, created_by: _c, ...rest } = m;
	return { ...rest, minutes: m.minutes ? JSON.parse(m.minutes) : null, pieces, actions,
		access: accessInfo(org(), m), can_manage: canManage(u, m) };
}

// Staff can review (pending / approved / skipped). Only the admin side (MCP, scripts) marks items done after
// creating them in Zoho or Outlook, and may attach the resulting ids.
const STAFF_STATUSES = ["pending", "approved", "skipped"], DONE_STATUSES = ["created", "draft", "sent"];
const EDITABLE = ["task", "owner", "due_date", "priority", "title", "date", "start_time", "subject", "body", "to"];
const ADMIN_FIELDS = ["zoho_id", "outlook_url", "event_id", "done_at", "note"];

export async function updateAction(u: User, id: string, key: string, b: Record<string, unknown>) {
	await loadMeeting(u, id);
	const d = await db();
	const row = await d.prepare("SELECT status, data FROM actions WHERE meeting_id=? AND key=?").bind(id, key).first<{ status: string; data: string }>();
	if (!row) throw new HttpError(404, "Action not found");
	if (DONE_STATUSES.includes(row.status) && !u.admin) throw new HttpError(409, "Already done");
	const data = JSON.parse(row.data);
	for (const f of EDITABLE) {
		if (typeof b[f] === "string") data[f] = (b[f] as string).slice(0, 5000);
		else if (f === "to" && Array.isArray(b[f])) data[f] = (b[f] as unknown[]).map(String).slice(0, 50);
	}
	if (u.admin) for (const f of ADMIN_FIELDS) if (typeof b[f] === "string") data[f] = (b[f] as string).slice(0, 2000);
	const allowed = u.admin ? [...STAFF_STATUSES, ...DONE_STATUSES] : STAFF_STATUSES;
	const status = allowed.includes(b.status as string) ? b.status as string : row.status;
	if (DONE_STATUSES.includes(status) && !data.done_at) data.done_at = new Date().toISOString();
	await d.prepare("UPDATE actions SET status=?, data=? WHERE meeting_id=? AND key=?").bind(status, JSON.stringify(data), id, key).run();
	return { key, status, ...data };
}

// Approved items across every meeting the caller can see, oldest first: the to-do list for Claude Code.
export async function approvedActions(u: User) {
	const d = await db();
	const rows = (await d.prepare(`SELECT a.meeting_id, a.key, a.type, a.status, a.data, m.title, m.date, m.visibility, m.viewers, m.created_by
		FROM actions a JOIN meetings m ON m.id = a.meeting_id WHERE a.status = 'approved' ORDER BY m.created_at, a.rowid`)
		.all<{ meeting_id: string; key: string; type: string; status: string; data: string } & MeetingRow>()).results;
	const o = org();
	return rows.filter(r => canSee(u, r)).map(r => ({
		meeting_id: r.meeting_id, meeting_title: r.title, meeting_date: r.date, key: r.key, type: r.type, status: r.status,
		visibility: r.visibility || "everyone", viewers: accessInfo(o, r).viewers, ...JSON.parse(r.data),
	}));
}

export function staffList() {
	return org().staff.map(s => ({ name: s.name, role: s.role, email: s.email || "", sees_all: s.access === "all" }));
}

// ---------- router ----------
async function api(req: Request, u: User, p: string) {
	const body = async () => req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
	let m: RegExpMatchArray | null;
	if (p === "/api/check" || p === "/api/me")
		return json({ ok: true, org_name: org().org_name, staff: staffList(), me: { name: u.name, email: u.email, sees_all: u.all, admin: u.admin } });
	if (p === "/api/hints" && req.method === "PUT") return json(await putHints(u, await body() as Partial<Hints>));
	if (p === "/api/hints" && req.method === "GET") {
		const h = await getHints();
		return json({ people: h?.people?.length || 0, employers: h?.employers?.length || 0 });
	}
	if (p === "/api/meetings" && req.method === "GET") return json(await listMeetings(u));
	if (p === "/api/meetings" && req.method === "POST") return json(await createMeeting(u, await body()));
	if (p === "/api/actions/approved" && req.method === "GET") return json(await approvedActions(u));
	if ((m = p.match(/^\/api\/meetings\/([\w-]+)$/))) {
		if (req.method === "GET") return json(await getMeeting(u, m[1]));
		if (req.method === "PATCH") return json(await updateMeeting(u, m[1], await body()));
		if (req.method === "DELETE") return json(await deleteMeeting(u, m[1]));
	}
	if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/access$/)) && req.method === "POST") return json(await setAccess(u, m[1], await body()));
	if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/pieces\/(\d+)$/)) && req.method === "POST") return addPiece(req, u, m[1], Number(m[2]));
	if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/finish$/)) && req.method === "POST") return json(await finish(u, m[1]));
	if ((m = p.match(/^\/api\/meetings\/([\w-]+)\/actions\/([\w-]+)$/)) && req.method === "POST") return json(await updateAction(u, m[1], m[2], await body()));
	return err("Unknown route", 404);
}

export default {
	async fetch(req: Request) {
		const url = new URL(req.url);
		const p = url.pathname;
		try {
			if (p === "/" || p === "/index.html")
				return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
			if (p === "/auth/login") return login(req);
			if (p === "/auth/callback") return callback(req, await db(), org());
			if (p === "/auth/logout") return logout(req, await db());
			if (p !== "/mcp" && !p.startsWith("/api/")) return new Response("Not found", { status: 404 });
			const u = await currentUser(req, await db(), org());
			if (p === "/mcp") return handleMcp(req, u);
			if (!u) return err("Please sign in", 401);
			return await api(req, u, p);
		} catch (e) {
			if (e instanceof HttpError) return err(e.message, e.status);
			return err(e instanceof Error ? e.message : String(e), 500);
		}
	},
} satisfies ExportedHandler;
