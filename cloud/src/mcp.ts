// Remote MCP server (Streamable HTTP, stateless JSON responses) so Claude Code can run the whole meeting workflow:
// read meetings and transcripts, work the approved-actions queue, mark items done after creating them in Zoho or
// Outlook, re-run minutes, manage who can see a meeting, and refresh the CRM name hints.
// Auth: the admin key (x-admin-key or "Authorization: Bearer <key>"). Staff sessions can't use it.
import type { User } from "./auth";
import {
	HttpError, approvedActions, deleteMeeting, finish, getHints, getMeeting, listMeetings, putHints,
	setAccess, staffList, updateAction, updateMeeting, db,
} from "./index";

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const str = (description: string) => ({ type: "string", description });
const id = { id: str("Meeting id, e.g. 2026-11-10-f5382515") };

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>;
	annotations?: Record<string, boolean>; run: (u: User, a: Record<string, any>) => Promise<unknown> };

const TOOLS: Tool[] = [
	{
		name: "list_meetings", annotations: { readOnlyHint: true },
		description: "List meetings, newest first, with status (recording / processing / ready / error), task and approved counts, and who can see each one.",
		inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 500 },
			status: { type: "string", enum: ["recording", "processing", "ready", "error"] } } },
		run: (u, a) => listMeetings(u, a.limit || 50, a.status),
	},
	{
		name: "get_meeting", annotations: { readOnlyHint: true },
		description: "One meeting: minutes (summary, topics, decisions, open questions, recap email), every proposed action with its review status, and access. Transcript only if include_transcript is true.",
		inputSchema: { type: "object", required: ["id"], properties: { ...id, include_transcript: { type: "boolean" } } },
		run: async (u, a) => { const m = await getMeeting(u, a.id); if (!a.include_transcript) delete (m as any).pieces; return m; },
	},
	{
		name: "get_transcript", annotations: { readOnlyHint: true },
		description: "The raw transcript of a meeting as timestamped one-minute pieces. No speaker labels.",
		inputSchema: { type: "object", required: ["id"], properties: id },
		run: async (u, a) => { const m = await getMeeting(u, a.id); return { id: m.id, title: m.title, date: m.date, pieces: m.pieces }; },
	},
	{
		name: "list_approved_actions", annotations: { readOnlyHint: true },
		description: "Everything staff approved that hasn't been done yet, across all meetings: tasks to create in Zoho CRM, follow-up meetings to invite, recap emails to draft. Each item includes the meeting's visibility and viewers (send private-meeting recaps only to viewers).",
		inputSchema: { type: "object", properties: {} },
		run: u => approvedActions(u),
	},
	{
		name: "update_action",
		description: "Edit or change the status of one action. After creating it elsewhere, set status created (task/invite), draft or sent (email) and attach zoho_id / outlook_url / event_id so the web page shows it as done. pending / approved / skipped are the review states.",
		inputSchema: { type: "object", required: ["meeting_id", "key"], properties: {
			meeting_id: str("Meeting id"), key: str("Action key, e.g. A3, F1, EMAIL"),
			status: { type: "string", enum: ["pending", "approved", "skipped", "created", "draft", "sent"] },
			task: str("Task title"), owner: str("Owner's full staff name or 'Unassigned'"), due_date: str("YYYY-MM-DD"),
			priority: { type: "string", enum: ["High", "Normal", "Low"] },
			title: str("Follow-up meeting title"), date: str("YYYY-MM-DD"), start_time: str("HH:MM"),
			subject: str("Recap email subject"), body: str("Recap email body"), to: { type: "array", items: { type: "string" }, description: "Recap email recipients" },
			zoho_id: str("Zoho CRM record id"), outlook_url: str("Outlook web link"), event_id: str("Calendar event id"), note: str("Free note"),
		} },
		run: (u, a) => { const { meeting_id, key, ...rest } = a; return updateAction(u, meeting_id, key, rest); },
	},
	{
		name: "regenerate_minutes", annotations: { destructiveHint: true },
		description: "Re-write a meeting's minutes with Claude from its transcript (uses the current name hints). Replaces pending/approved/skipped actions; items already created or sent are kept. Costs about $0.20 per hour of meeting and can take several minutes.",
		inputSchema: { type: "object", required: ["id"], properties: id },
		run: (u, a) => finish(u, a.id),
	},
	{
		name: "set_meeting_access",
		description: "Change who can see a meeting. visibility 'everyone' = all staff; 'private' = only the listed staff emails plus the person who started it. Staff with full access (see list_staff) always see everything.",
		inputSchema: { type: "object", required: ["id", "visibility"], properties: { ...id,
			visibility: { type: "string", enum: ["everyone", "private"] },
			viewers: { type: "array", items: { type: "string" }, description: "Staff emails (from list_staff)" } } },
		run: (u, a) => setAccess(u, a.id, a),
	},
	{
		name: "update_meeting",
		description: "Rename a meeting, change its date, or set who was in it (attendees help Claude assign task owners on the next regenerate_minutes).",
		inputSchema: { type: "object", required: ["id"], properties: { ...id, title: str("New title"), date: str("YYYY-MM-DD"),
			participants: { type: "array", description: "Replaces the list. Staff: {email}. Guests: {name, org}.",
				items: { type: "object", properties: { email: { type: "string" }, name: { type: "string" }, org: { type: "string" } } } } } },
		run: (u, a) => updateMeeting(u, a.id, a),
	},
	{
		name: "delete_meeting", annotations: { destructiveHint: true },
		description: "Permanently delete a meeting with its transcript, minutes and actions. Cannot be undone; confirm with the user first.",
		inputSchema: { type: "object", required: ["id"], properties: id },
		run: (u, a) => deleteMeeting(u, a.id),
	},
	{
		name: "list_staff", annotations: { readOnlyHint: true },
		description: "Staff who can sign in: name, role, Zoho email, and whether they see every meeting.",
		inputSchema: { type: "object", properties: {} },
		run: async () => staffList(),
	},
	{
		name: "get_name_hints", annotations: { readOnlyHint: true },
		description: "How many CRM names (leads, students, employers) the minutes writer currently uses, and when they were last refreshed.",
		inputSchema: { type: "object", properties: {} },
		run: async () => {
			const h = await getHints();
			const r = await (await db()).prepare("SELECT updated_at FROM hints WHERE id = 1").first<{ updated_at: number }>();
			return { people: h?.people?.length || 0, employers: h?.employers?.length || 0,
				updated_at: r ? new Date(r.updated_at).toISOString() : null };
		},
	},
	{
		name: "set_name_hints",
		description: "Replace the CRM name list the minutes writer uses to spell people and employers. people = current leads and students ({name, note}, note = 'lead' or batch code, add '(current batch)' for active batches); employers = company names. Don't include old batches.",
		inputSchema: { type: "object", required: ["people"], properties: {
			people: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" }, note: { type: "string" } } } },
			employers: { type: "array", items: { type: "string" } } } },
		run: (u, a) => putHints(u, a),
	},
	{
		name: "app_status", annotations: { readOnlyHint: true },
		description: "Quick health check: meetings by status, approved items waiting, name-hint counts.",
		inputSchema: { type: "object", properties: {} },
		run: async u => {
			const list = await listMeetings(u, 500);
			const by: Record<string, number> = {};
			for (const m of list) by[m.status] = (by[m.status] || 0) + 1;
			const h = await getHints();
			return { meetings: list.length, by_status: by, approved_waiting: (await approvedActions(u)).length,
				name_hints: { people: h?.people?.length || 0, employers: h?.employers?.length || 0 } };
		},
	},
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

async function handle(u: User, msg: Rpc) {
	const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
	const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
	if (msg.id === undefined || msg.id === null) return null; // notification: nothing to answer
	switch (msg.method) {
		case "initialize": {
			const asked = msg.params?.protocolVersion;
			return ok({
				protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "meeting-agent", version: "1.0.0" },
				instructions: "Meeting Agent: recorded staff meetings, their minutes and the actions staff approved. " +
					"Typical loop: list_approved_actions → create each item in Zoho CRM / Outlook with the user's OK → update_action with status created/draft/sent and the new id. " +
					"Never delete meetings or send email without the user's explicit yes.",
			});
		}
		case "ping": return ok({});
		case "tools/list":
			return ok({ tools: TOOLS.map(({ run: _r, ...t }) => t) });
		case "tools/call": {
			const tool = TOOLS.find(t => t.name === msg.params?.name);
			if (!tool) return fail(-32602, `Unknown tool: ${msg.params?.name}`);
			try {
				const out = await tool.run(u, msg.params?.arguments || {});
				return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: Array.isArray(out) ? { items: out } : out });
			} catch (e) {
				const m = e instanceof HttpError || e instanceof Error ? e.message : String(e);
				return ok({ content: [{ type: "text", text: m }], isError: true });
			}
		}
		default: return fail(-32601, `Method not found: ${msg.method}`);
	}
}

export async function handleMcp(req: Request, u: User | null) {
	if (!u?.admin) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Admin key required" } }, { status: 401 });
	if (req.method === "GET") return new Response("This MCP server only answers POST (no event stream).", { status: 405, headers: { allow: "POST" } });
	if (req.method === "DELETE") return new Response(null, { status: 204 });
	if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
	let body: Rpc | Rpc[];
	try { body = await req.json(); } catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
	const batch = Array.isArray(body);
	const replies = (await Promise.all((batch ? body as Rpc[] : [body as Rpc]).map(m => handle(u, m)))).filter(Boolean);
	if (!replies.length) return new Response(null, { status: 202 });
	return Response.json(batch ? replies : replies[0]);
}
