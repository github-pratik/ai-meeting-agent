import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Organisation details (staff list, API keys, team code) are secrets, never in this public repo.
// Set them with: cf deploy --secrets-file .env.secrets.json   (git-ignored)
export default defineConfig({
	worker: {
		name: "meeting-agent",
		compatibilityDate: "2026-11-04",
		entrypoint,
		env: {
			AI: bindings.ai(),                                // Whisper large-v3-turbo (Workers AI, free daily allowance)
			DB: bindings.d1({ name: "meeting-agent-db" }),     // meetings, transcript pieces, minutes, approvals
			ANTHROPIC_API_KEY: bindings.secret(),             // Claude, for the minutes
			ORG_CONFIG: bindings.secret(),                    // JSON: org_name, org_description, staff[{name, email, access}], vocabulary[]
			ZOHO_CLIENT_ID: bindings.secret(),                // Zoho API console "server-based" client, for staff sign-in
			ZOHO_CLIENT_SECRET: bindings.secret(),
			ADMIN_API_KEY: bindings.secret(),                 // for scripts and the /mcp endpoint (x-admin-key header)
			APP_URL: bindings.secret(),                       // public URL of this app, used in links inside Zoho tasks and the sheet
			// Automatic sync of accepted tasks (each side optional; leave empty to switch it off)
			ZOHO_SELF_CLIENT_ID: bindings.secret(),           // Zoho API console "Self Client" with Tasks/Events/users scopes
			ZOHO_SELF_CLIENT_SECRET: bindings.secret(),
			ZOHO_REFRESH_TOKEN: bindings.secret(),
			ZOHO_CRM_API: bindings.secret(),                  // https://www.zohoapis.com (or https://sandbox.zohoapis.com to test)
			MS_TENANT_ID: bindings.secret(),                  // Microsoft Entra app (client credentials, Sites.Selected)
			MS_CLIENT_ID: bindings.secret(),
			MS_CLIENT_SECRET: bindings.secret(),
			MS_TTP_DRIVE_ID: bindings.secret(),               // the Time Task Plan workbook (drive id + item id)
			MS_TTP_ITEM_ID: bindings.secret(),
			GROQ_API_KEY: bindings.secret(),                  // Groq Whisper, backup transcriber (free tier)
			GROQ_MODEL: bindings.text("whisper-large-v3-turbo"),         // or "whisper-large-v3" (full model)
		},
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })], // retry failed syncs, pull completions from Zoho
	},
});
