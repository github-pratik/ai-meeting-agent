import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

export const MODEL = "claude-opus-5-5";

const ActionItem = z.object({
	id: z.string().describe("A1, A2, ..."),
	task: z.string().describe("Imperative, specific, self-contained task title"),
	owner: z.string().describe("Full staff name, a guest as 'Name (Company)', or 'Unassigned'"),
	owner_basis: z.enum(["named", "inferred", "none"]).describe("named = the owner's name was said; inferred = worked out from who was asked and who answered; none = Unassigned"),
	due_date: z.string().describe("YYYY-MM-DD resolved from the meeting date, or ''"),
	due_text: z.string().describe("How the deadline was said, or ''"),
	priority: z.enum(["High", "Normal", "Low"]),
	related_to: z.string().describe("Named student, lead, employer or batch, or ''"),
	timestamp: z.string().describe("HH:MM:SS where it was agreed"),
	quote: z.string().describe("Short verbatim quote that supports it"),
});

export const Minutes = z.object({
	summary: z.string().describe("3-6 sentence plain-language summary"),
	topics: z.array(z.object({ title: z.string(), notes: z.array(z.string()) })),
	decisions: z.array(z.object({ decision: z.string(), made_by: z.string() })),
	action_items: z.array(ActionItem),
	follow_up_meetings: z.array(z.object({
		title: z.string(), date: z.string(), start_time: z.string(),
		duration_minutes: z.number(), attendees: z.array(z.string()), purpose: z.string(),
	})),
	open_questions: z.array(z.string()),
	recap_email_subject: z.string(),
	recap_email_body: z.string().describe("Plain-text recap: summary, decisions, each person's tasks with dates, open questions. Ends with 'Thanks,'"),
});
export type MinutesT = z.infer<typeof Minutes>;

export type Org = {
	org_name: string;
	org_description: string;
	// email = the Zoho account they sign in with; access "all" = sees every meeting, including private ones
	staff: { name: string; role: string; aliases?: string[]; email?: string; access?: "all" }[];
	vocabulary: string[];
};

// Name hints pushed from the CRM (PUT /api/hints). Kept in D1, never in the repo.
export type Hints = {
	people: { name: string; note?: string }[]; // current leads and students, note = "lead" / batch code
	employers: string[];
};

const SYSTEM = (org: Org) => `You are the meeting secretary for ${org.org_name}, ${org.org_description}.

Turn a meeting transcript into accurate minutes that staff can act on.

Rules:
- Only record what was actually said. Never invent tasks, owners, dates or decisions.
- An action item is a concrete commitment or request someone accepted. Ideas, status updates and complaints are not actions.
- The transcript has NO speaker labels (one microphone in the room). Take a task owner from a name actually
  spoken (e.g. "Sam, can you..." followed by agreement): owner_basis "named".
- If an attendee list is given and has 4 people or fewer, you may also work out the owner of a first-person
  commitment ("I'll send it Friday") from the flow of the conversation: who was asked, who answered, which side
  each person is on (staff vs. a guest's company). Set owner_basis "inferred". Only do this when the flow makes it
  clear; otherwise use 'Unassigned' with owner_basis "none". Never infer with 5+ attendees or no attendee list.
- Guests (outside people) can own commitments too; write them as 'Name (Company)'. A guest's commitment is still
  an action item, so staff can track it.
- If attendees are given, name them in the recap email's first line.
- Resolve relative dates against the meeting date. 'This week' with no day = the Friday of the meeting week.
- A follow-up meeting only counts if a day or time was agreed. List it under follow_up_meetings only, not also as an action item.
- Open questions = things someone explicitly raised and left undecided. Do not add your own concerns.
- Transcription can misspell names and terms; correct them using the staff list and vocabulary.
- If a "Known people" or "Known employers" list is given, use it to spell students, leads and employers exactly
  as the CRM has them, and prefer someone in a current batch when a first name matches several people.
  Several first names said in a row ("Eli Jarrell Eric") are usually separate people: never join them into one
  full name unless that exact full name is on the list. Expand a first name to a full name only when the list
  has exactly one fitting match (right program and timing); otherwise keep the first name as heard.
- Keep it short and plain. Staff read this on a phone.`;

const ts = (s: number) => new Date(Math.max(0, s) * 1000).toISOString().substring(11, 19);

export async function writeMinutes(apiKey: string, org: Org, title: string, date: string,
	pieces: { start_s: number; text: string }[], hints?: Hints | null,
	attendees: { name: string; role?: string; org?: string; guest: boolean }[] = []) {
	const day = new Date(`${date}T12:00:00Z`);
	const weekday = day.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
	const transcript = pieces.map(p => `[${ts(p.start_s)}] ${p.text}`).join("\n");
	const context = `Meeting: ${title}
Meeting date: ${date} (${weekday})
Staff list: ${org.staff.map(s => `${s.name} (${s.role}; also called ${(s.aliases || []).join(", ") || "-"})`).join("; ")}
Vocabulary: ${org.vocabulary.join(", ")}` +
		(attendees.length ? `\nAttendees (${attendees.length}): ${attendees.map(a => a.guest ? `${a.name} (guest${a.org ? `, ${a.org}` : ""})` : `${a.name} (staff, ${a.role || ""})`).join("; ")}` : "\nAttendees: not given") +
		(hints?.people?.length ? `\nKnown people (CRM spelling; note = lead or batch): ${hints.people.map(p => p.note ? `${p.name} [${p.note}]` : p.name).join("; ")}` : "") +
		(hints?.employers?.length ? `\nKnown employers: ${hints.employers.join("; ")}` : "");

	const client = new Anthropic({ apiKey });
	const res = await client.messages.parse(
		{
			model: MODEL,
			max_tokens: 16000,
			system: SYSTEM(org),
			output_config: { effort: "medium", format: zodOutputFormat(Minutes) },
			messages: [{ role: "user", content: `${context}\n<transcript>\n${transcript}\n</transcript>` }],
			// On a safety decline, re-run on Anthropic's recommended fallback model instead of failing.
			fallbacks: "default",
		} as Parameters<typeof client.messages.parse>[0],
		{ headers: { "anthropic-beta": "server-side-fallback-2026-07-01" } },
	);
	if (res.stop_reason === "refusal") throw new Error("Claude declined this transcript");
	if (res.stop_reason === "max_tokens" || !res.parsed_output) throw new Error(`Incomplete minutes (${res.stop_reason}); try again`);
	const cost = res.usage.input_tokens * 4 / 1e6 + res.usage.output_tokens * 20 / 1e6;
	return { minutes: res.parsed_output as MinutesT, cost, model: res.model };
}
