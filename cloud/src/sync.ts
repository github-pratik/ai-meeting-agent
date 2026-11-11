// Keeps accepted meeting actions in step with Zoho CRM and the staff Time Task Plan workbook (SharePoint Excel).
//   accepted task      → Zoho CRM Task (owner = that person, Zoho emails them) + a row in their TTP tab
//   edited             → both updated;  owner changed → old row removed, new owner re-accepts
//   skipped / undone   → Zoho task deleted, row removed;  meeting deleted → same for all its items
//   marked done (app)  → Zoho task Completed, row "Done";  completed in Zoho → app + row "Done" (15-min sweep)
//   accepted follow-up → Zoho CRM Event with the staff attendees invited
// Each side is optional: with no Zoho or Microsoft keys set, that side is simply skipped.
import { env } from "cloudflare:workers";
import type { Org } from "./minutes";

type Staff = Org["staff"][number];
export type ActionRow = { meeting_id: string; key: string; type: string; status: string; data: string };
type MeetingInfo = { id: string; title: string; date: string; participants?: string };
type Data = Record<string, any>;

const has = (...v: (string | undefined)[]) => v.every(x => !!x && x.trim() !== "");
export const zohoOn = () => has(env.ZOHO_SELF_CLIENT_ID, env.ZOHO_SELF_CLIENT_SECRET, env.ZOHO_REFRESH_TOKEN);
export const sheetOn = () => has(env.MS_TENANT_ID, env.MS_CLIENT_ID, env.MS_CLIENT_SECRET, env.MS_TTP_DRIVE_ID, env.MS_TTP_ITEM_ID);
const appUrl = () => (env.APP_URL || "").replace(/\/$/, "");
const crmApi = () => (env.ZOHO_CRM_API || "https://www.zohoapis.com").replace(/\/$/, "");

// ---------- small key/value cache in D1 (access tokens, user list) ----------
async function cacheGet(db: D1Database, k: string) {
	const r = await db.prepare("SELECT v, exp FROM kv WHERE k = ?").bind(k).first<{ v: string; exp: number }>();
	return r && r.exp > Date.now() ? r.v : null;
}
const cachePut = (db: D1Database, k: string, v: string, ttlMs: number) =>
	db.prepare("INSERT OR REPLACE INTO kv (k, v, exp) VALUES (?, ?, ?)").bind(k, v, Date.now() + ttlMs).run();

// ---------- Zoho CRM ----------
async function zohoToken(db: D1Database) {
	const hit = await cacheGet(db, "zoho_token");
	if (hit) return hit;
	const r = await fetch("https://accounts.zoho.com/oauth/v2/token", { method: "POST", body: new URLSearchParams({
		grant_type: "refresh_token", refresh_token: env.ZOHO_REFRESH_TOKEN,
		client_id: env.ZOHO_SELF_CLIENT_ID, client_secret: env.ZOHO_SELF_CLIENT_SECRET,
	}) });
	const j = await r.json<{ access_token?: string; expires_in?: number; error?: string }>();
	if (!j.access_token) throw new Error(`Zoho sign-in failed: ${j.error || r.status}`);
	await cachePut(db, "zoho_token", j.access_token, ((j.expires_in || 3600) - 300) * 1000);
	return j.access_token;
}
async function zoho(db: D1Database, method: string, path: string, body?: unknown) {
	const r = await fetch(`${crmApi()}/crm/v8${path}`, {
		method, headers: { authorization: `Zoho-oauthtoken ${await zohoToken(db)}`, "content-type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (r.status === 204) return null;
	const j = await r.json<any>().catch(() => ({}));
	const rec = j?.data?.[0];
	if (!r.ok || (rec?.status && rec.status !== "success")) throw new Error(`Zoho ${method} ${path.split("?")[0]}: ${rec?.message || j?.message || r.status}`);
	return j;
}
async function zohoUserId(db: D1Database, email: string) {
	let list = await cacheGet(db, "zoho_users");
	if (!list) {
		const j = await zoho(db, "GET", "/users?type=ActiveUsers&per_page=200");
		list = JSON.stringify((j?.users || []).map((x: any) => ({ id: x.id, email: String(x.email || "").toLowerCase() })));
		await cachePut(db, "zoho_users", list, 6 * 3600e3);
	}
	return (JSON.parse(list) as { id: string; email: string }[]).find(x => x.email === email.toLowerCase())?.id;
}

// America/New_York offset for a date, e.g. "-05:00"
function nyOffset(date: string) {
	const d = new Date(`${date}T12:00:00Z`);
	const ny = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
	const mins = Math.round((ny.getTime() - new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime()) / 60000);
	const s = mins < 0 ? "-" : "+", a = Math.abs(mins);
	return `${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}
const prettyDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const link = (m: MeetingInfo) => appUrl() ? `${appUrl()}/#/m/${encodeURIComponent(m.id)}` : "";

function taskBody(m: MeetingInfo, d: Data, ownerId: string, status: string) {
	const desc = [`From the meeting "${m.title}" on ${m.date}${d.timestamp ? ` at ${d.timestamp}` : ""}.`,
		d.quote ? `Said: "${d.quote}"` : "", d.related_to ? `Related to: ${d.related_to}` : "",
		link(m) ? `Open in Meeting Agent: ${link(m)}` : ""].filter(Boolean).join("\n");
	return { Subject: String(d.task || "").slice(0, 250), Due_Date: /^\d{4}-\d{2}-\d{2}$/.test(d.due_date || "") ? d.due_date : null,
		Priority: ["High", "Normal", "Low"].includes(d.priority) ? d.priority : "Normal",
		Status: status === "done" ? "Completed" : "Not Started", Owner: { id: ownerId }, Description: desc, Send_Notification_Email: true };
}

function eventBody(m: MeetingInfo, d: Data, ownerId: string, participantIds: string[]) {
	const off = nyOffset(d.date);
	const [h, mi] = String(d.start_time).split(":").map(Number);
	const endMin = Math.min(23 * 60 + 59, h * 60 + mi + (Number(d.duration_minutes) > 0 ? Number(d.duration_minutes) : 30));
	const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
	return { Event_Title: String(d.title || "Follow-up meeting").slice(0, 250),
		Start_DateTime: `${d.date}T${hhmm(h * 60 + mi)}:00${off}`, End_DateTime: `${d.date}T${hhmm(endMin)}:00${off}`,
		Owner: { id: ownerId }, Participants: participantIds.map(p => ({ type: "user", participant: p })),
		Description: [d.purpose, `Agreed in "${m.title}" on ${m.date}.`, (d.attendees || []).length ? `Attendees: ${d.attendees.join(", ")}` : "",
			link(m) ? `Open in Meeting Agent: ${link(m)}` : ""].filter(Boolean).join("\n"),
		$send_notification: true };
}

// ---------- Microsoft Graph: Time Task Plan workbook ----------
async function graphToken(db: D1Database) {
	const hit = await cacheGet(db, "ms_token");
	if (hit) return hit;
	const r = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, { method: "POST", body: new URLSearchParams({
		grant_type: "client_credentials", client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET,
		scope: "https://graph.microsoft.com/.default",
	}) });
	const j = await r.json<{ access_token?: string; expires_in?: number; error_description?: string }>();
	if (!j.access_token) throw new Error(`Microsoft sign-in failed: ${(j.error_description || String(r.status)).slice(0, 160)}`);
	await cachePut(db, "ms_token", j.access_token, ((j.expires_in || 3600) - 300) * 1000);
	return j.access_token;
}
// Every sheet change for one item runs inside one Excel session, so a read right after a write sees that write.
type Sid = string | undefined;
async function graph(db: D1Database, method: string, path: string, body?: unknown, sid?: Sid) {
	const base = `https://graph.microsoft.com/v1.0/drives/${env.MS_TTP_DRIVE_ID}/items/${env.MS_TTP_ITEM_ID}/workbook`;
	for (let attempt = 0; attempt < 3; attempt++) {
		const headers: Record<string, string> = { authorization: `Bearer ${await graphToken(db)}`, "content-type": "application/json" };
		if (sid) headers["workbook-session-id"] = sid;
		const r = await fetch(base + path, { method, headers,
			body: body ? JSON.stringify(body) : undefined });
		if (r.status === 429 || r.status === 503 || r.status === 504) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
		if (r.status === 204) return null;
		const j = await r.json<any>().catch(() => ({}));
		if (r.status === 404) return { notFound: true };
		if (!r.ok) throw new Error(`Sheet ${method}: ${j?.error?.message || r.status}`.slice(0, 200));
		return j;
	}
	throw new Error("Sheet: Microsoft is busy, will retry");
}
async function openSession(db: D1Database): Promise<Sid> {
	const j = await graph(db, "POST", "/createSession", { persistChanges: true }).catch(() => null);
	return j?.id;
}
const closeSession = (db: D1Database, sid: Sid) => sid ? graph(db, "POST", "/closeSession", {}, sid).catch(() => null) : null;
const ws = (tab: string) => `/worksheets/${encodeURIComponent(tab)}`;
const tableName = (tab: string) => `MeetingTasks_${tab.replace(/[^A-Za-z0-9]+/g, "_")}`;
const HEADERS = ["Task", "Due date", "Status", "Priority", "Meeting", "Link", "Ref"];
const colEnd = String.fromCharCode(64 + HEADERS.length); // "G"

// The app owns one table per tab, two rows below whatever people typed. It never edits anything else.
async function ensureTable(db: D1Database, tab: string, sid?: Sid) {
	const name = tableName(tab);
	if (await cacheGet(db, `table:${env.MS_TTP_ITEM_ID}:${name}`)) return name;
	const t = await graph(db, "GET", `/tables/${name}?$select=name`, sid);
	if (!t?.notFound) { await cachePut(db, `table:${env.MS_TTP_ITEM_ID}:${name}`, "1", 86400e3); return name; }
	const used = await graph(db, "GET", `${ws(tab)}/usedRange(valuesOnly=true)?$select=address`, sid);
	if (used?.notFound) throw new Error(`Sheet tab "${tab}" not found`);
	const last = Number(String(used?.address || "A1").match(/(\d+)$/)?.[1] || 1);
	const titleRow = last + 3, headRow = titleRow + 1;
	await graph(db, "PATCH", `${ws(tab)}/range(address='A${titleRow}')`, { values: [["From meetings — kept up to date by the Meeting Agent. Edit or accept tasks in the app, not here."]] }, sid);
	await graph(db, "PATCH", `${ws(tab)}/range(address='A${titleRow}')/format/font`, { bold: true }, sid);
	await graph(db, "PATCH", `${ws(tab)}/range(address='A${headRow}:${colEnd}${headRow}')`, { values: [HEADERS] }, sid);
	const made = await graph(db, "POST", `${ws(tab)}/tables/add`, { address: `A${headRow}:${colEnd}${headRow + 1}`, hasHeaders: true }, sid);
	await graph(db, "PATCH", `/tables/${made.id}`, { name }, sid);
	// Excel sometimes widens a new table to match the data above it; drop any columns past ours.
	const cols = ((await graph(db, "GET", `/tables/${name}/columns?$select=id,index`, sid))?.value || []) as { id: string; index: number }[];
	for (const c of cols.filter(c => c.index >= HEADERS.length).sort((a, b) => b.index - a.index))
		await graph(db, "DELETE", `/tables/${name}/columns/${c.id}`, undefined, sid);
	await graph(db, "PATCH", `/tables/${name}/headerRowRange`, { values: [HEADERS] }, sid);   // make sure the column names stick
	await cachePut(db, `table:${env.MS_TTP_ITEM_ID}:${name}`, "1", 86400e3);
	return name;
}
async function tableRows(db: D1Database, name: string, sid?: Sid) {
	const j = await graph(db, "GET", `/tables/${name}/rows?$select=index,values`, undefined, sid);
	return ((j?.value || []) as { index: number; values: unknown[][] }[]).map(r => ({ index: r.index, values: r.values[0] }));
}
async function upsertRow(db: D1Database, tab: string, ref: string, values: string[], sid?: Sid) {
	const name = await ensureTable(db, tab, sid);
	let rows = await tableRows(db, name, sid);
	const width = rows[0]?.values.length || HEADERS.length;   // fit the row to the table, whatever its width
	values = [...values, ...Array(Math.max(0, width - values.length)).fill("")].slice(0, width);
	const mine = rows.filter(r => r.values[HEADERS.length - 1] === ref);
	if (mine[0]) await graph(db, "PATCH", `/tables/${name}/rows/itemAt(index=${mine[0].index})`, { values: [values] }, sid);
	else await graph(db, "POST", `/tables/${name}/rows`, { values: [values] }, sid);
	rows = await tableRows(db, name, sid);
	const drop = [...rows.filter(r => r.values[HEADERS.length - 1] === ref).slice(1),          // leftovers from an interrupted sync
		...rows.filter(r => r.values.every(v => v === "" || v === null))];                       // the blank row a new table starts with
	if (rows.length - drop.length >= 1)
		for (const r of drop.sort((x, y) => y.index - x.index)) await graph(db, "DELETE", `/tables/${name}/rows/itemAt(index=${r.index})`, undefined, sid);
}
async function removeRow(db: D1Database, tab: string, ref: string, sid?: Sid) {
	const name = tableName(tab);
	const rows = await tableRows(db, name, sid).catch(() => []);
	const mine = rows.filter(r => r.values[HEADERS.length - 1] === ref).sort((a, b) => b.index - a.index);
	let left = rows.length;
	for (const hit of mine) {   // a table must keep one row: blank it instead of deleting the last one
		if (left === 1) await graph(db, "PATCH", `/tables/${name}/rows/itemAt(index=${hit.index})`, { values: [HEADERS.map(() => "")] }, sid);
		else { await graph(db, "DELETE", `/tables/${name}/rows/itemAt(index=${hit.index})`, undefined, sid); left--; }
	}
}

// ---------- the sync itself ----------
const staffByName = (o: Org, name: string) => o.staff.find(s => s.name === name);
const attendeeStaff = (o: Org, d: Data) => (d.attendees || []).map((a: string) =>
	o.staff.find(s => s.name === a || s.name.split(" ")[0] === a.split(" ")[0] || (s.aliases || []).includes(a))).filter(Boolean) as Staff[];

const SYNC_FIELDS = ["zoho_id", "zoho_kind", "zoho_owner_id", "sheet_tab", "sync_error", "synced_at", "synced_rev"];

/** Bring one action in line with Zoho and the sheet. Runs one at a time per action (a short lock in its own row),
 *  always re-reads the latest version, writes back only its own fields, and goes again if the item changed meanwhile. */
/** Before deleting a meeting: wait for any running sync on its items, then remove them from Zoho and the sheet. */
export async function unsyncMeeting(db: D1Database, o: Org, m: MeetingInfo) {
	const list = (await db.prepare("SELECT key FROM actions WHERE meeting_id = ? AND type IN ('task','meeting')").bind(m.id).all<{ key: string }>()).results;
	for (const { key } of list) {
		for (let i = 0; i < 20; i++) {
			const r = await db.prepare("SELECT COALESCE(json_extract(data,'$.sync_lock'),0) AS lock FROM actions WHERE meeting_id = ? AND key = ?").bind(m.id, key).first<{ lock: number }>();
			if (!r || !r.lock || r.lock < Date.now() - 60_000) break;
			await new Promise(res => setTimeout(res, 2000));
		}
		const a = await db.prepare("SELECT meeting_id, key, type, status, data FROM actions WHERE meeting_id = ? AND key = ?").bind(m.id, key).first<ActionRow>();
		if (!a) continue;
		const d = JSON.parse(a.data);
		if (d.zoho_id || d.sheet_tab || ["approved", "done"].includes(a.status)) await syncOnce(db, o, m, a, { gone: true });
	}
}

export async function syncAction(db: D1Database, o: Org, m: MeetingInfo, a: ActionRow, opts: { gone?: boolean; approverEmail?: string } = {}) {
	if (opts.gone) return syncOnce(db, o, m, a, opts);   // meeting being deleted: work from the snapshot, write nothing
	for (let round = 0; round < 3; round++) {
		const now = Date.now();
		const lock = await db.prepare(`UPDATE actions SET data = json_set(data, '$.sync_lock', ?) WHERE meeting_id = ? AND key = ?
			AND COALESCE(json_extract(data, '$.sync_lock'), 0) < ?`).bind(now, a.meeting_id, a.key, now - 60_000).run();
		if (!lock.meta.changes) return null;   // another sync is on it; it re-checks for changes before it stops
		const row = await db.prepare("SELECT meeting_id, key, type, status, data FROM actions WHERE meeting_id = ? AND key = ?")
			.bind(a.meeting_id, a.key).first<ActionRow>();
		if (!row) return null;
		const rev = Number(JSON.parse(row.data).rev || 0);
		const d = await syncOnce(db, o, m, row, opts);
		d.synced_rev = rev;
		await db.prepare(`UPDATE actions SET data = json_set(data, ${SYNC_FIELDS.map(f => `'$.${f}', ?`).join(", ")}, '$.sync_lock', 0)
			WHERE meeting_id = ? AND key = ?`).bind(...SYNC_FIELDS.map(f => d[f] ?? ""), a.meeting_id, a.key).run();
		const after = await db.prepare("SELECT json_extract(data, '$.rev') AS rev FROM actions WHERE meeting_id = ? AND key = ?")
			.bind(a.meeting_id, a.key).first<{ rev: number | null }>();
		if (Number(after?.rev || 0) === rev) return d;
	}
	return null;
}

async function syncOnce(db: D1Database, o: Org, m: MeetingInfo, a: ActionRow, opts: { gone?: boolean; approverEmail?: string }) {
	const d: Data = JSON.parse(a.data);
	const errors: string[] = [];
	const live = !opts.gone && ["approved", "done"].includes(a.status);
	const ref = `${a.meeting_id}:${a.key}`;

	if (a.type === "task") {
		const owner = staffByName(o, d.owner);
		const want = live && owner?.email;
		if (zohoOn()) {
			try {
				if (want) {
					const ownerId = await zohoUserId(db, owner!.email!);
					if (!ownerId) throw new Error(`${owner!.name} has no active Zoho CRM user`);
					const body = taskBody(m, d, ownerId, a.status);
					if (d.zoho_id) {
						try { await zoho(db, "PUT", `/Tasks/${d.zoho_id}`, { data: [body] }); }
						catch (e) { if (/INVALID_DATA|not found|record not found|ENTITY_ID_INVALID/i.test(String(e))) d.zoho_id = ""; else throw e; }
					}
					if (!d.zoho_id) d.zoho_id = (await zoho(db, "POST", "/Tasks", { data: [body] }))?.data?.[0]?.details?.id;
					d.zoho_kind = "Tasks";
				} else if (d.zoho_id) {
					await zoho(db, "DELETE", `/Tasks/${d.zoho_id}`).catch(e => { if (!/not found|INVALID_DATA/i.test(String(e))) throw e; });
					d.zoho_id = ""; d.zoho_kind = "";
				}
			} catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
		}
		if (sheetOn()) {
			const sid = await openSession(db);
			try {
				const tab = want ? owner?.sheet_tab || "" : "";
				if (d.sheet_tab && d.sheet_tab !== tab) { await removeRow(db, d.sheet_tab, ref, sid); d.sheet_tab = ""; }
				if (opts.gone && owner?.sheet_tab && owner.sheet_tab !== d.sheet_tab) await removeRow(db, owner.sheet_tab, ref, sid);
				if (tab) {
					await upsertRow(db, tab, ref, [String(d.task || ""), d.due_date ? `'${prettyDate(d.due_date)}` : "", a.status === "done" ? "Done" : "To do",
						d.priority || "Normal", `${m.title} (${m.date})`, link(m) ? `=HYPERLINK("${link(m)}","Open")` : "", ref], sid);
					d.sheet_tab = tab;
				}
			} catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
			finally { await closeSession(db, sid); }
		}
	}

	if (a.type === "meeting" && zohoOn()) {
		try {
			const want = live && /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") && /^\d{2}:\d{2}$/.test(d.start_time || "");
			if (want) {
				const people = attendeeStaff(o, d);
				const ids = (await Promise.all(people.map(p => zohoUserId(db, p.email!)))).filter(Boolean) as string[];
				const approver = opts.approverEmail ? await zohoUserId(db, opts.approverEmail) : undefined;
				const ownerId = d.zoho_owner_id || approver || ids[0];
				if (!ownerId) throw new Error("No staff member to own the calendar event");
				const body = eventBody(m, d, ownerId, ids);
				if (d.zoho_id) await zoho(db, "PUT", `/Events/${d.zoho_id}`, { data: [body] });
				else d.zoho_id = (await zoho(db, "POST", "/Events", { data: [body] }))?.data?.[0]?.details?.id;
				d.zoho_kind = "Events"; d.zoho_owner_id = ownerId;
			} else if (d.zoho_id) {
				await zoho(db, "DELETE", `/Events/${d.zoho_id}`).catch(e => { if (!/not found|INVALID_DATA/i.test(String(e))) throw e; });
				d.zoho_id = ""; d.zoho_kind = ""; d.zoho_owner_id = "";
			}
		} catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
	}

	d.sync_error = errors.join(" · ").slice(0, 400);
	d.synced_at = new Date().toISOString();
	return d;
}

/** Every 15 minutes: retry anything that failed or never synced, and pull "Completed" back from Zoho. */
export async function sweep(db: D1Database, o: Org) {
	const out = { retried: 0, completed: 0, errors: 0 };
	if (!zohoOn() && !sheetOn()) return out;
	const todo = (await db.prepare(`SELECT a.meeting_id, a.key, a.type, a.status, a.data, m.id, m.title, m.date, m.participants
		FROM actions a JOIN meetings m ON m.id = a.meeting_id
		WHERE a.type IN ('task','meeting') AND (
		  (a.status IN ('approved','done') AND (COALESCE(json_extract(a.data,'$.synced_rev'),-1) <> COALESCE(json_extract(a.data,'$.rev'),0)
		     OR COALESCE(json_extract(a.data,'$.sync_error'),'') <> ''))
		  OR (a.status IN ('pending','skipped') AND (COALESCE(json_extract(a.data,'$.zoho_id'),'') <> '' OR COALESCE(json_extract(a.data,'$.sheet_tab'),'') <> '')))
		LIMIT 25`).all<ActionRow & MeetingInfo>()).results;
	for (const r of todo) { const d = await syncAction(db, o, r, r); out.retried++; if (d?.sync_error) out.errors++; }

	if (zohoOn()) {
		const open = (await db.prepare(`SELECT a.meeting_id, a.key, a.type, a.status, a.data, m.id, m.title, m.date, m.participants
			FROM actions a JOIN meetings m ON m.id = a.meeting_id
			WHERE a.type = 'task' AND a.status = 'approved' AND COALESCE(json_extract(a.data,'$.zoho_id'),'') <> '' LIMIT 100`)
			.all<ActionRow & MeetingInfo>()).results;
		if (open.length) {
			const ids = open.map(r => JSON.parse(r.data).zoho_id).join(",");
			const j = await zoho(db, "GET", `/Tasks?ids=${ids}&fields=Status`).catch(() => null);
			const done = new Set(((j?.data || []) as { id: string; Status: string }[]).filter(t => t.Status === "Completed").map(t => t.id));
			for (const r of open.filter(r => done.has(JSON.parse(r.data).zoho_id))) {
				await db.prepare(`UPDATE actions SET status = 'done', data = json_set(data, '$.done_at', ?, '$.done_in', 'zoho',
					'$.rev', COALESCE(json_extract(data, '$.rev'), 0) + 1) WHERE meeting_id = ? AND key = ? AND status = 'approved'`)
					.bind(new Date().toISOString(), r.meeting_id, r.key).run();
				await syncAction(db, o, r, r);
				out.completed++;
			}
		}
	}
	return out;
}
