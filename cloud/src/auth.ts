// Zoho sign-in (OpenID Connect) and per-person sessions.
// Staff sign in with their Zoho account; the email must be on the staff list in ORG_CONFIG.
// Scripts and the MCP endpoint use a separate admin key instead (x-admin-key header).
import { env } from "cloudflare:workers";
import type { Org } from "./minutes";

export type User = { email: string; name: string; all: boolean; admin: boolean };

const SESSION_DAYS = 30;
const ZOHO_ACCOUNTS = /^https:\/\/accounts\.zoho\.(com|eu|in|com\.au|jp|ca|sa|uk|com\.cn)$/;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(s: string) {
	return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}
function timingSafeEqual(a: string, b: string) {
	if (!a || !b || a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}
function cookie(req: Request, name: string) {
	const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return m ? decodeURIComponent(m[1]) : "";
}
const setCookie = (name: string, value: string, maxAge: number) =>
	`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export function staffByEmail(org: Org, email: string) {
	const e = email.trim().toLowerCase();
	return org.staff.find(s => (s.email || "").toLowerCase() === e);
}

// Who is calling: admin key (scripts, MCP) or a signed-in staff member's session cookie.
export async function currentUser(req: Request, db: D1Database, org: Org): Promise<User | null> {
	const key = req.headers.get("x-admin-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
	if (key && env.ADMIN_API_KEY && timingSafeEqual(key, env.ADMIN_API_KEY))
		return { email: "admin-api", name: "Admin (API)", all: true, admin: true };
	// Browser: session cookie. Desktop app: the same kind of session token, sent as a bearer token.
	const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
	const token = cookie(req, "ma_session") || bearer;
	if (!token) return null;
	const row = await db.prepare("SELECT email FROM sessions WHERE token_hash = ? AND expires_at > ?")
		.bind(await sha256(token), Date.now()).first<{ email: string }>();
	if (!row) return null;
	const s = staffByEmail(org, row.email); // removing someone from the staff list signs them out everywhere
	if (!s) return null;
	return { email: row.email.toLowerCase(), name: s.name, all: s.access === "all", admin: s.access === "all" };
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(
	`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Meeting Agent</title>
	<body style="font:16px -apple-system,Segoe UI,Arial,sans-serif;max-width:420px;margin:60px auto;padding:0 16px">${body}</body>`,
	{ status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });

export function login(req: Request) {
	if (!env.ZOHO_CLIENT_ID) return html("<p>Zoho sign-in isn't set up yet. Ask your admin.</p>", 503);
	const url = new URL(req.url), state = randomToken(), verifier = randomToken(48);
	return sha256(verifier).then(challenge => {
		const auth = new URL("https://accounts.zoho.com/oauth/v2/auth");
		auth.search = new URLSearchParams({
			response_type: "code", client_id: env.ZOHO_CLIENT_ID, scope: "openid email profile",
			redirect_uri: `${url.origin}/auth/callback`, state, code_challenge: challenge, code_challenge_method: "S256",
			access_type: "online", // Zoho rejects prompt=select_account with a 400
		}).toString();
		const h = new Headers({ location: auth.toString() });
		h.append("set-cookie", setCookie("ma_state", `${state}.${verifier}`, 600));
		const next = url.searchParams.get("next") || "";
		if (/^\/auth\/desktop\?nonce=[\w-]{16,64}$/.test(next)) h.append("set-cookie", setCookie("ma_next", next, 600));
		return new Response(null, { status: 302, headers: h });
	});
}

export async function callback(req: Request, db: D1Database, org: Org) {
	const url = new URL(req.url);
	const [state, verifier] = cookie(req, "ma_state").split(".");
	if (url.searchParams.get("error")) return html(`<p>Sign-in was cancelled.</p><p><a href="/auth/login">Try again</a></p>`, 400);
	if (!state || url.searchParams.get("state") !== state) return html(`<p>Sign-in expired. <a href="/auth/login">Try again</a></p>`, 400);
	const server = url.searchParams.get("accounts-server") || "https://accounts.zoho.com";
	if (!ZOHO_ACCOUNTS.test(server)) return html("<p>Unexpected Zoho server.</p>", 400);

	const r = await fetch(`${server}/oauth/v2/token`, {
		method: "POST",
		body: new URLSearchParams({
			grant_type: "authorization_code", code: url.searchParams.get("code") || "",
			client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET,
			redirect_uri: `${url.origin}/auth/callback`, code_verifier: verifier || "",
		}),
	});
	const tok = await r.json<{ id_token?: string; error?: string }>().catch(() => ({} as { id_token?: string; error?: string }));
	if (!tok.id_token) return html(`<p>Zoho didn't confirm the sign-in (${tok.error || r.status}).</p><p><a href="/auth/login">Try again</a></p>`, 502);
	// The ID token came straight from Zoho's token endpoint over TLS, so its claims can be trusted (OIDC Core 3.1.3.7).
	let claims: { email?: string; email_verified?: boolean | string; aud?: string; exp?: number; iss?: string };
	try { claims = JSON.parse(atob(tok.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); }
	catch { return html("<p>Couldn't read the Zoho sign-in.</p>", 502); }
	const email = (claims.email || "").toLowerCase();
	if (claims.aud !== env.ZOHO_CLIENT_ID || (claims.exp || 0) * 1000 < Date.now() || !ZOHO_ACCOUNTS.test(claims.iss || ""))
		return html("<p>The Zoho sign-in didn't check out. <a href=\"/auth/login\">Try again</a></p>", 401);
	if (claims.email_verified === false || claims.email_verified === "false")
		return html("<p>Your Zoho email isn't verified yet.</p>", 403);
	const s = staffByEmail(org, email);
	if (!s) return html(`<p><b>${email.replace(/[<>&"]/g, "")}</b> isn't on the team list for this app.</p>
		<p>Ask your admin to add you, or <a href="/auth/login">sign in with another Zoho account</a>.</p>`, 403);

	const token = randomToken();
	await db.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
		.bind(await sha256(token), email, Date.now(), Date.now() + SESSION_DAYS * 864e5).run();
	await db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
	const next = cookie(req, "ma_next");
	const h = new Headers({ location: /^\/auth\/desktop\?nonce=[\w-]{16,64}$/.test(next) ? next : "/#/" });
	h.append("set-cookie", setCookie("ma_next", "", 0));
	h.append("set-cookie", setCookie("ma_session", token, SESSION_DAYS * 86400));
	h.append("set-cookie", setCookie("ma_state", "", 0));
	return new Response(null, { status: 302, headers: h });
}

export async function logout(req: Request, db: D1Database) {
	const token = cookie(req, "ma_session");
	if (token) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
	return new Response(null, { status: 302, headers: { location: "/", "set-cookie": setCookie("ma_session", "", 0) } });
}

// Desktop app sign-in. The app opens /auth/desktop?nonce=<random> in the browser; once the person is signed in there,
// we mint a separate long-lived session for the app and hand it back through the meetingagent:// link with the same
// nonce, which the app checks. Removing someone from the staff list still cuts the app off.
const DESKTOP_DAYS = 180;
export async function desktopHandoff(req: Request, db: D1Database, org: Org) {
	const url = new URL(req.url);
	const nonce = url.searchParams.get("nonce") || "";
	if (!/^[\w-]{16,64}$/.test(nonce)) return html("<p>Open this from the Meeting Agent desktop app.</p>", 400);
	const u = await currentUser(req, db, org);
	if (!u || u.email === "admin-api") {
		return new Response(null, { status: 302, headers: { location: `/auth/login?next=${encodeURIComponent(`/auth/desktop?nonce=${nonce}`)}` } });
	}
	const token = randomToken();
	await db.prepare("INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)")
		.bind(await sha256(token), u.email, Date.now(), Date.now() + DESKTOP_DAYS * 864e5).run();
	const link = `meetingagent://signed-in?token=${encodeURIComponent(token)}&nonce=${encodeURIComponent(nonce)}`;
	return html(`<h2 style="margin:0 0 8px">Signed in as ${u.name.replace(/[<>&"]/g, "")}</h2>
		<p>Click the button to finish signing in the desktop app, then close this tab.</p>
		<p><a href="${link}" style="display:inline-block;background:#92302C;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Open Meeting Agent</a></p>
		<script>location.href = ${JSON.stringify(link)};</script>`, 200, { "cache-control": "no-store", "referrer-policy": "no-referrer" });
}

export async function desktopLogout(req: Request, db: D1Database) {
	const bearer = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1] || "";
	if (bearer) await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(bearer)).run();
	return Response.json({ ok: true });
}
